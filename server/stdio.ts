import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
// This is a bridge, not a second state store. Start the local application first.
const url = new URL(process.env.WIRING_STUDIO_URL || 'http://127.0.0.1:4317/mcp');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  throw new Error('MCP bridge requires a loopback URL');
const client = new Client({ name: 'wiring-studio-stdio-bridge', version: '0.1.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(url));
} catch (err) {
  console.error(
    'Запустите Wiring Studio (npm start) перед подключением MCP:',
    (err as Error).message,
  );
  process.exit(1);
}
const server = new Server(
  { name: 'wiring-studio', version: '0.1.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, () => client.listTools());
server.setRequestHandler(CallToolRequestSchema, (r) => client.callTool(r.params) as any);
await server.connect(new StdioServerTransport());
process.on('SIGINT', async () => {
  await client.close();
  await server.close();
  process.exit(0);
});
