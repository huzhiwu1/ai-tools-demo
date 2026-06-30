// 用户 → 会话（一对多）
curl -s http://localhost:3005/conversations/users/2 | jq
// 会话 → 消息（一对多）
curl -s http://localhost:3005/conversations/2/messages | jq
// 语义检索
curl -s -X POST http://localhost:3005/conversations/2/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"向量相似度怎么查","limit":3}' | jq

curl -s -X POST 'http://localhost:3005/conversations/2/search?limit=5' \
  -H 'Content-Type: application/json' \
  -d '{"query":"PostgreSQL 支持哪些数据类型"}' | jq