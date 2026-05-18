# MCP Server 改进文档 - 分段读取与上下文引用

## 🆕 新增功能

### 1. 大内容分段读取 (Chunked Reading)

#### 问题背景
之前遇到 142KB 等大文件时返回不完整，需要多次请求拼凑。

#### 解决方案
现在 `file` 工具的 `fetch` 操作支持分段读取：

**参数说明**:
- `chunkStart`: 字节偏移量（默认：0）
- `chunkSize`: 单次最大返回字节数（默认：50KB）
- `isLargeContent`: 自动标记大文件 (>100KB)
- `chunk`: 分段信息对象

**返回示例**:
```json
{
  "success": true,
  "status": 200,
  "body": "...",
  "chunk": {
    "currentChunk": 1,
    "totalChunks": 3,
    "chunkStart": 0,
    "chunkEnd": 49999,
    "totalSize": 142000,
    "isLastChunk": false,
    "nextStart": 50000
  },
  "isLargeContent": true,
  "totalLength": 142000
}
```

#### 使用示例

**获取大文件第一部分**:
```javascript
{
  "action": "fetch",
  "url": "https://target.com/large-document.html",
  "chunkStart": 0,
  "chunkSize": 50000
}
```

**获取大文件第二部分**:
```javascript
{
  "action": "fetch",
  "url": "https://target.com/large-document.html",
  "chunkStart": 50000,
  "chunkSize": 50000
}
```

**获取大文件第三部分**:
```javascript
{
  "action": "fetch",
  "url": "https://target.com/large-document.html",
  "chunkStart": 100000,
  "chunkSize": 42000
}
```

**获取完整大文件**:
```javascript
// 先检查大小
{
  "action": "fetch",
  "url": "https://target.com/large-document.html",
  "chunkSize": 1000
}

// 如果返回 totalLength=200000，则分 4 次获取
[
  { chunkStart: 0, chunkSize: 50000 },
  { chunkStart: 50000, chunkSize: 50000 },
  { chunkStart: 100000, chunkSize: 50000 },
  { chunkStart: 150000, chunkSize: 50000 }
]
```

---

### 2. 跨工具上下文引用 (Cross-Tool Linkage)

#### 问题背景
工具之间需手动复制粘贴结果，自动化程度低。

#### 解决方案
通过 `referenceId` 参数在工具间建立关联：

**参数说明**:
- `referenceId`: 用户自定义引用 ID（最大 64 字符）
- 同一 ID 的所有响应会携带相同 ID 便于追踪

**返回增强**:
```json
{
  "success": true,
  "referenceId": "asset_discovery_001",
  "data": {...}
}
```

#### 使用示例

**跨工具引用流程**:

1. **DNS 探测并标记**:
```javascript
{
  "action": "dig",
  "domain": "ubn.net",
  "referenceId": "asset_discovery_001"
}
```

2. **HTTP 探测关联同一目标**:
```javascript
{
  "action": "fetch",
  "url": "https://ubn.net",
  "referenceId": "asset_discovery_001"
}
```

3. **分析阶段继续引用**:
```javascript
{
  "action": "analyze",
  "sourceReferenceId": "asset_discovery_001",
  "comparison": true
}
```

---

### 3. 优化 JSON 返回格式

#### 改进内容

**结构化输出**:
- `chunk` 信息独立对象（避免大 JSON）
- `isLargeContent` 自动标记
- `totalLength`/`contentLength` 分离
- `referenceId` 在所有响应中保持一致

**返回对比**:

**之前**:
```json
{
  "success": true,
  "status": 200,
  "body": "大文件内容...",  // 可能截断
  "headers": {...}
}
```

**现在**:
```json
{
  "success": true,
  "status": 200,
  "statusOk": true,
  "body": "部分或全部...",  // 分段完整
  "chunk": {
    "currentChunk": 1,
    "totalChunks": 3,
    "nextStart": 50000
  },
  "isLargeContent": true,
  "totalLength": 142000,
  "contentLength": 142000,
  "headers": {...},
  "referenceId": "asset_discovery_001"
}
```

---

## 📝 实际操作流程示例

### 场景 1: 探测大文档内容

**目标**: 探测包含 142KB phpMyAdmin 文档 HTML

**步骤**:

1. **探测第一部分 (0-50KB)**:
```javascript
{
  "action": "fetch",
  "url": "https://dev.ubn.net/phpmyadmin/doc/html/setup.html",
  "chunkStart": 0,
  "chunkSize": 50000,
  "referenceId": "pma_doc_001"
}
```
响应:
```json
{
  "success": true,
  "chunk": { "currentChunk": 1, "totalChunks": 3, "nextStart": 50000 },
  "isLargeContent": true,
  "totalLength": 142000
}
```

2. **探测第二部分 (50KB-100KB)**:
```javascript
{
  "action": "fetch",
  "url": "https://dev.ubn.net/phpmyadmin/doc/html/setup.html",
  "chunkStart": 50000,
  "chunkSize": 50000,
  "referenceId": "pma_doc_001"
}
```
响应:
```json
{
  "success": true,
  "chunk": { "currentChunk": 2, "totalChunks": 3, "nextStart": 100000 }
}
```

3. **探测第三部分 (100KB-142KB)**:
```javascript
{
  "action": "fetch",
  "url": "https://dev.ubn.net/phpmyadmin/doc/html/setup.html",
  "chunkStart": 100000,
  "chunkSize": 42000,
  "referenceId": "pma_doc_001"
}
```
响应:
```json
{
  "success": true,
  "chunk": { "currentChunk": 3, "totalChunks": 3, "isLastChunk": true }
}
```

### 场景 2: 资产发现交叉引用

**目标**: 探测多个子域名并关联结果

**步骤**:

1. **DNS 探测与标记**:
```javascript
{
  "action": "dig",
  "domain": "ubn.net",
  "referenceId": "asset_discovery_ubn"
}
```

2. **HTTP 存活探测**:
```javascript
{
  "action": "fetch",
  "url": "https://ubn.net",
  "referenceId": "asset_discovery_ubn",
  "chunkSize": 1000
}
```

3. **phpMyAdmin 探测**:
```javascript
{
  "action": "fetch",
  "url": "https://ubn.net/phpmyadmin/",
  "referenceId": "asset_discovery_ubn"
}
```

4. **文档内容探测**:
```javascript
{
  "action": "fetch",
  "url": "https://ubn.net/phpmyadmin/doc/html/index.html",
  "referenceId": "asset_discovery_ubn",
  "chunkSize": 50000
}
```

**结果汇总**: 所有四个请求的 `referenceId` 均为 `asset_discovery_ubn`，便于后续关联分析。

---

## 🔧 使用建议

### 何时使用分段读取

✅ **推荐使用**:
- 文件大小 > 50KB
- 需要避免 JSON 截断
- 响应时间过长（分段返回加快）

❌ **不推荐**:
- 小文件 (< 5KB)，直接全部返回
- 实时性要求极高场景

### 最佳实践

```javascript
// 智能分段策略
function smartFetch(url, referenceId = null) {
  // 1. 先用 HEAD 获取大小
  const head = fetchUrl(url, 'HEAD', referenceId);
  
  // 2. 判断是否分段
  if (head.totalLength > 100000) {
    return fetchChunks(url, 50000, referenceId);
  } else {
    return fetchUrl(url, 'GET', 0, 200000, referenceId);
  }
}
```

### 参考 ID 管理

```javascript
// 命名规范
const refs = {
  asset_discovery: "asset_discovery_ubn",
  pma_version: "pma_doc_001",
  subdomain_scan: "subdomain_ubn_20260211",
  report: "final_report_001"
};

// 自动关联
const relatedResponses = [res1, res2, res3].filter(
  r => r.referenceId === refs.pma_version
);
```

---

## 📊 性能对比

### 改进前 vs 改进后

| 场景 | 改进前 | 改进后 | 提升 |
|:-:|:-:|:-:|:-:|
| 142KB 文件 | 部分截断，需猜测 | 分 3 次完整获取 | ✅ 完整 |
| 跨工具引用 | 手动复制粘贴 | referenceId 自动关联 | ✅ 自动化 |
| JSON 响应 | 大对象扁平化 | 分段结构化 | ✅ 易读 |
| 用户体验 | "内容缺失" | "获取中/已完成" | ✅ 友好 |

---

## 🚀 下一步建议

基于本次改进，推荐后续优化：

1. **批量扫描**: 支持 `batchFetch` 一次探测多个 URL
2. **自动化管道**: `dig ubn.net | fetch ubn.net` 自动关联
3. **结果汇总**: 自动生成结构化探测报告
4. **缓存优化**: DNS 查询结果自动缓存 5 分钟

---

**文档版本**: v1.1  
**更新日期**: 2026-02-11  
**作者**: Hermes Agent
