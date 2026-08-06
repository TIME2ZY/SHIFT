# Legacy project Memory export

> Historical product memories that were stored as `scope=project`.
> They are **not** adopted project decisions. Prefer formal ADRs under `docs/decisions/`.

- Batch: `memory-thread-only-2026-08-06`
- Applied: yes
- Count: 23

## constraint / auth-no-refresh-token

- id: `f76bfabe-f921-427a-9e3f-c5db1f8bc646`
- origin_thread: `1785156700293-u4yvs7`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-27T12:53:53.446Z
- created_by: grok

本期明确不做 refresh token；禁止实现 refresh 换发路由、refresh 表、双 token 续期前端逻辑

## constraint / auth-callback-token-isolation

- id: `a66c94f5-5f21-491c-b91d-c97b9629a2a7`
- origin_thread: `1785156700293-u4yvs7`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-27T12:53:53.661Z
- created_by: grok

用户登录凭证与 callback 的 x-callback-token 隔离；callback 路由不混用用户 JWT/session

## constraint / no-dual-source

- id: `a3e9a3e4-8f0a-478f-803e-bad9fc1fc5ca`
- origin_thread: `1785156700293-u4yvs7`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-27T12:54:35.600Z
- created_by: grok

禁止两套在线数据源：业务读写不得双写/双读分裂；SQLite 为唯一在线真相

## decision / auth-session-ttl

- id: `207d34a0-8156-4f3f-bc2e-9a1ff03ea541`
- origin_thread: `1785156700293-u4yvs7`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-27T12:55:08.757Z
- created_by: grok

登录态/access token 有效期 24 小时（运营反馈，已从约一周改短）；实现时 access/session TTL 对齐约 86400s 量级，允许小幅配置化但默认 24h。不做 refresh token。

## decision / auth-phase-scope

- id: `171d3a4d-62ac-4b56-9ec1-34335e214dac`
- origin_thread: `1785156700293-u4yvs7`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-27T12:55:08.863Z
- created_by: grok

登录能力本期范围：用户密码登录 + 约 24 小时会话保持 + 无 refresh；在现有本机 UI token / Host 绑定之上叠加或替换用户态（具体叠加策略待拍板）

## decision / auth-login-api

- id: `1acf0bf5-d02c-4eb4-ba59-911ddb4dc52c`
- origin_thread: `1785156700293-u4yvs7`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-27T12:56:26.078Z
- created_by: grok

POST /api/login：JSON {username,password}；成功 200 返回 accessToken/expiresIn=86400/tokenType=Bearer/user；密码错与用户不存在统一 401 invalid_credentials 防枚举；校验失败 400；限流 429 rate_limited；无 refresh 字段；错误体 {error,code} 并与现有 sendJson 风格兼容

## constraint / auth-login-enumeration

- id: `e3ebda38-e4b0-4b47-b6eb-0b6ddc10f4e7`
- origin_thread: `1785156700293-u4yvs7`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-27T12:56:31.708Z
- created_by: grok

登录失败不得区分「用户不存在」与「密码错误」：同一 HTTP 状态、同一 code=invalid_credentials、同一 error 文案；禁止 404 user_not_found 等可枚举响应

## decision / auth-logout-revoke

- id: `36348366-ebe6-47bd-84a5-e4ad3a412082`
- origin_thread: `1785156700293-u4yvs7`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-27T12:58:11.949Z
- created_by: grok

无 refresh、仅 access JWT：纯客户端丢弃不算服务端吊销。若要真 logout/吊销，须在同一 SQLite 记 jti/session 吊销或会话行（与业务库同源），鉴权路径查库；TTL 默认 86400s 后自然失效。禁止另起 Redis 黑名单主写。不做 refresh 续期。

## constraint / auth-logout-cannot

- id: `63a67a8b-8b6b-4804-8a24-e5a1c0ce239b`
- origin_thread: `1785156700293-u4yvs7`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-27T12:58:12.053Z
- created_by: grok

本期不得承诺：纯无状态 JWT 下即时全局作废、跨设备秒级踢人（无吊销表时）、吊销后仍兼容无 jti 的旧 token、用 logout 代替改密/密钥轮换。Stolen token 在无服务端吊销记录前仍可到 exp。

## decision / auth-test-matrix

- id: `043e2c15-7224-4d7c-8a70-473ebbded088`
- origin_thread: `1785161300834-pb6jid`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-27T14:10:38.252Z
- created_by: grok

鉴权最小自动化用例：login_ok(200/Bearer/expiresIn=604800/无refresh)；bad_password与unknown_user同401 invalid_credentials；rate_limit第6次429；protected无/坏/过期Bearer 401；B下logout后同jti 401；缺UI token调login仍现网401；callback不接受用户JWT冒充。

## decision / auth-scope

- id: `785172c0-5f60-4030-9ecd-904a4a8478b0`
- origin_thread: `1785161300834-pb6jid`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-27T14:10:38.356Z
- created_by: grok

登录能力本期范围：用户密码登录 + 约 7 天会话保持 + 无 refresh；叠在现有本机 UI token / Host 门禁之上；用户凭证与 callback x-callback-token 隔离。

## decision / auth-impl-order

- id: `6425aea3-497d-433e-a784-34bc009837c9`
- origin_thread: `1785161300834-pb6jid`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-27T14:10:38.464Z
- created_by: grok

用户鉴权实现顺序：① schema（auth_users + 可选 auth_sessions/jti）→ ② POST /api/login（及可选 logout）→ ③ JWT 中间件叠在 UI/Host 门禁且与 callback token 隔离 → ④ 契约/隔离/吊销测试。TTL 604800、无 refresh、SQLite 单真相、现代慢哈希。

## constraint / auth-no-user-enum

- id: `6f46714e-4c6b-447d-95b6-84df3f91bf95`
- origin_thread: `1785161300834-pb6jid`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-27T14:10:38.683Z
- created_by: grok

登录失败不得区分用户不存在与密码错误：同一 HTTP 状态、同一 code=invalid_credentials、同一 error 文案；禁止 404 user_not_found 等可枚举响应。

## constraint / auth-revocation-limits

- id: `6ff4b6d8-f4fa-4902-a8ca-663b2c69ff96`
- origin_thread: `1785161300834-pb6jid`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-27T14:10:38.788Z
- created_by: grok

本期不得承诺：无吊销表时即时全局作废/跨设备秒级踢人；吊销后仍兼容无 jti 的旧 token；用 logout 代替改密或 JWT 密钥轮换。无服务端吊销记录时 stolen token 可存活到 exp（默认最长约 7 天）。

## constraint / storage-no-dual-source

- id: `921b2893-0b67-4f22-a207-309614ea1e2e`
- origin_thread: `1785161300834-pb6jid`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-27T14:12:38.634Z
- created_by: grok

禁止两套在线数据源：业务读写不得双写/双读分裂；SQLite 为唯一在线真相。

## decision / auth-token-isolation

- id: `42b5d4e7-084c-43aa-91e0-7c2fdb93d812`
- origin_thread: `1785246396403-4dacbw`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-28T13:51:28.536Z
- created_by: codex

每个 jti 对应独立会话；单设备注销只撤销当前会话，退出全部设备必须使用显式的按用户全量撤销操作。SQLite 存 SHA-256(jti)，User-Agent 仅作展示信息，不作为设备绑定凭据。

## decision / auth-password-hash

- id: `4a70aec6-0da0-4619-bf89-813703770f76`
- origin_thread: `1785246396403-4dacbw`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-28T13:53:07.377Z
- created_by: grok

密码哈希采用 Node 内置 crypto.scrypt（无 argon2 依赖）；禁止 bcrypt/MD5/SHA 单次哈希。参数：N=16384,r=8,p=1,keylen=32，salt>=16 字节随机，存储格式 scrypt。

## decision / auth-login-contract

- id: `17ded99e-0992-4fd3-9bf0-03beac1ea110`
- origin_thread: `1785246396403-4dacbw`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-28T13:53:07.516Z
- created_by: grok

POST /api/login：body {username,password}；成功 200 Set-Cookie HttpOnly SameSite=Strict Path=/（loopback HTTP 可省略 Secure），JSON 返回 {expiresIn:604800,tokenType:Cookie,user} 且不回传 JWT 明文、无 refresh；失败 401 invalid_credentials 统一文案；限流 429 rate_limited；仍需 UI token 门禁。

## decision / auth-session-model

- id: `d9911cc8-7427-4704-bf57-bc20b8268bc4`
- origin_thread: `1785246396403-4dacbw`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-28T13:53:07.656Z
- created_by: grok

Access JWT HS256 + SQLite auth_sessions：jti 密码学随机>=128bit，库存 SHA-256(jti)；鉴权=验签(alg白名单/exp/iss/aud/sub/jti)+有效会话行，DB 异常 fail-closed；logout 撤销写入成功才 200；logout-all 显式按用户撤销。

## decision / auth-token-ttl

- id: `89905aa0-3a09-49e5-965e-c573e5c89b1c`
- origin_thread: `1785246396403-4dacbw`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-28T13:54:57.780Z
- created_by: codex

Access JWT 与 SQLite 会话默认 TTL 均为 604800 秒（7 天）；本期无 refresh，因此二者承载完整登录窗口并同时到期。

## constraint / auth-no-refresh

- id: `40f35569-5cad-4733-a3a2-7a6e92392116`
- origin_thread: `1785246396403-4dacbw`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-28T13:54:57.925Z
- created_by: codex

本期不实现 refresh token：禁止 refresh 路由、存储字段、双 token 换发及前端静默续期；登录响应不含 refresh 字段。

## decision / storage-primary

- id: `8e024f8f-4b04-4874-927c-33f0ca06b930`
- origin_thread: `1785246396403-4dacbw`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-28T13:54:58.067Z
- created_by: codex

SQLite 是用户、会话/吊销和业务数据的唯一在线真相源；不引入 Redis 或第二套在线主写。

## decision / local-dev-port

- id: `88df5461-1d28-44ea-8450-db55a7abaa2b`
- origin_thread: `1785246396403-4dacbw`
- project_key: `wt:bc59a2f103388304cb9665dc7c25d45a`
- created_at: 2026-07-28T13:54:58.231Z
- created_by: codex

本地控制台默认端口为 8787，服务默认仅监听 loopback；非 loopback 部署需单独启用 HTTPS 与可信来源/代理策略。
