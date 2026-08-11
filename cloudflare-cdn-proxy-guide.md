# Cloudflare CDN 中转代理配置指南

## 概述

通过 Cloudflare CDN 中转香港服务器（8.210.23.28）的代理流量，实现：
- 隐藏真实服务器 IP，避免 GFW 封锁
- 利用 Cloudflare 全球边缘节点中转 WebSocket 流量
- 协议：VLESS-WS-TLS（WebSocket 被 Cloudflare 默认支持）

## 流量路径

```
客户端（v2rayN）→ Cloudflare CDN（104.21.35.180 等）→ 香港服务器（8.210.23.28:443）
```

## 配置清单

### 1. Cloudflare DNS 配置

| 字段 | 值 |
|---|---|
| Type | A |
| Name | hk |
| IPv4 | 8.210.23.28 |
| Proxy status | **Proxied（橙色云朵）** |
| TTL | Auto |

完整域名：`hk.huzhiwu.online`

### 2. Cloudflare SSL/TLS 设置

- 加密模式：**Full**（非 Full strict）
- 这样 Cloudflare 到服务器之间使用现有 IP 证书即可，无需申请域名证书

### 3. NS 服务器配置

域名注册商处（阿里云万网）将 NS 修改为：
- `mitch.ns.cloudflare.com`
- `phoenix.ns.cloudflare.com`

删除原有的：
- ~~dns25.hichina.com~~
- ~~dns26.hichina.com~~

### 4. 3x-ui 入站配置

| 字段 | 值 | 说明 |
|---|---|---|
| 协议 | VLESS | 不变 |
| 地址 | **留空** | 监听 0.0.0.0，禁止填公网 IP |
| 端口 | 443 | 不变 |
| 传输 | ws（WebSocket） | 不变 |
| TLS | 开启 | 不变 |
| SNI / serverNames | **hk.huzhiwu.online** | 改为域名 |
| 证书 | 现有 IP 证书 | 不变 |

### 5. 客户端（v2rayN）配置

| 字段 | 值 |
|---|---|
| address | hk.huzhiwu.online |
| port | 443 |
| SNI (serverName) | hk.huzhiwu.online |
| 其他参数（uuid、path 等） | 不变 |

## 验证方法

### 验证 Cloudflare 代理是否生效

```bash
# 用 Google DNS 查询，应返回 Cloudflare IP（104.x.x.x 或 172.x.x.x）
nslookup hk.huzhiwu.online 8.8.8.8

# 用 Cloudflare DNS 查询
nslookup hk.huzhiwu.online 1.1.1.1
```

如果返回的是 `8.210.23.28`，说明代理未生效。

### 验证 NS 是否切换成功

```bash
nslookup -type=ns huzhiwu.online
```

应返回 `mitch.ns.cloudflare.com` 和 `phoenix.ns.cloudflare.com`。

## 常见问题

### 问题 1：DNS 缓存导致连接失败

症状：`dial tcp 8.210.23.28:443: i/o timeout`

原因：本地 DNS 缓存了旧的真实 IP 记录

解决：
1. 修改系统 DNS 为 `1.1.1.1` 或 `8.8.8.8`
2. 刷新 DNS 缓存：
```bash
sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder
```

### 问题 2：3x-ui 入站地址填了公网 IP

症状：Xray 启动失败，报错 `bind: cannot assign requested address`

解决：入站「地址」字段**留空**，不要填任何 IP

### 问题 3：NS 切换后不生效

NS 切换需要几分钟到 48 小时。可以通过 `nslookup -type=ns huzhiwu.online` 检查，或等待 Cloudflare 发送邮件通知。

## 环境信息

| 项目 | 值 |
|---|---|
| 域名 | huzhiwu.online |
| 代理子域名 | hk.huzhiwu.online |
| 香港服务器 IP | 8.210.23.28 |
| Xray 监听端口 | 443 |
| 3x-ui 面板端口 | 39224 |
| 协议 | VLESS-WS-TLS |
| Cloudflare SSL 模式 | Full |
