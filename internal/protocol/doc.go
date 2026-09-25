// Package protocol 实现 base 协议 v1：规范化 JSON、sha256/blob 寻址、Merkle 根、
// Ed25519 签名与 manifest 结构。必须与 packages/protocol-ts 行为一致，
// 一致性由 vectors/v1/*.json 黄金向量在两侧测试中同时消费来保证。
package protocol