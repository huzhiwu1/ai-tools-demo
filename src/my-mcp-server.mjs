import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// 模拟数据库数据
const database = {
  users: [
    {
      id: 10001,
      name: "张三",
      email: "zhangsan@example.com",
      age: 28,
      role: "管理员",
    },
    {
      id: 10002,
      name: "李四",
      email: "lisi@example.com",
      age: 32,
      role: "普通用户",
    },
    {
      id: 10003,
      name: "王五",
      email: "wangwu@example.com",
      age: 25,
      role: "访客",
    },
  ],
};

// 创建 MCP 服务器实例
const server = new McpServer({
  name: "my-mcp-server",
  version: "1.0.0",
});

// 注册工具：query_user
// 工具是 MCP 服务器提供给客户端（如 Trae, Claude）调用的函数
server.registerTool(
  "query_user",
  {
    description: "查询用户信息",
    inputSchema: z.object({
      userId: z.string().describe("用户ID"),
    }),
  },
  async ({ userId }) => {
    // 查找用户逻辑
    const user = database.users.find((user) => user.id === Number(userId)); // 注意：这里做了类型转换兼容
    if (!user) {
      return {
        content: [
          {
            type: "text",
            text: `用户${userId}不存在。可用的ID有${database.users
              .map((user) => user.id)
              .join(",")}`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `用户${userId}的信息如下：
        -姓名：${user.name}
        -邮箱：${user.email}
        -年龄：${user.age}
        -角色：${user.role}`,
        },
      ],
    };
  }
);

// 注册资源：使用指南
// 资源是 MCP 服务器提供的静态或动态内容，客户端可以直接读取
server.registerResource(
  "使用指南",
  "docs://guide",
  {
    description: "MCP Server 使用文档",
    mimeTypes: "text/plain",
  },
  async () => {
    return {
      contents: [
        {
          // 这里的 uri 是资源的唯一标识符，类似于 ID。
          // 它不必是真实的互联网 URL（如 http://...），可以是自定义协议（如 docs://...）。
          // 客户端使用这个 URI 来请求特定的资源内容。
          // "docs://guide" 只是我们自己定义的一个名字：
          // - "docs" 是我们虚构的协议名，表示这是文档类的资源
          // - "guide" 是具体的资源路径
          // 你完全可以把它改成 "my-app://help" 或 "resource:manual" 等任何字符串
          uri: "docs://guide",
          mimeType: "text/plain",
          text: `MCP Server 使用指南：
            功能：提供用户查询功能
            使用：在trae等MCP客户端中，通过自然语言对话，trae自然会调用该工具
            `,
        },
      ],
    };
  }
);

// 使用标准输入输出传输层连接服务器
// 这使得 MCP 客户端可以通过 spawn 进程的方式与此服务器通信
const transport = new StdioServerTransport();
await server.connect(transport);
