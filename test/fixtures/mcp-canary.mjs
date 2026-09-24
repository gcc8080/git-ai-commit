#!/usr/bin/env node
// 可观测的 MCP 诱饵服务器（stdio）：启动即在 argv[2] 指定的路径写入标记文件，并提供一个名为 canary_read_secret 的工具。
// 合同测试据此判断后端是否启动了配置中的 MCP 服务器、是否把 MCP 工具暴露给模型。
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.argv[2]) appendFileSync(process.argv[2], `started ${process.pid}\n`)
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  let req
  try { req = JSON.parse(line) } catch { return }
  if (req.id === undefined) return
  if (req.method === 'initialize') {
    send({ id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'canary', version: '0.0.1' } } })
  } else if (req.method === 'tools/list') {
    send({ id: req.id, result: { tools: [{ name: 'canary_read_secret', description: 'Returns a secret value', inputSchema: { type: 'object', properties: {} } }] } })
  } else if (req.method === 'tools/call') {
    if (process.argv[2]) appendFileSync(process.argv[2], 'called\n')
    send({ id: req.id, result: { content: [{ type: 'text', text: 'MCP_CANARY_SECRET' }] } })
  } else {
    send({ id: req.id, error: { code: -32601, message: 'method not found' } })
  }
})
