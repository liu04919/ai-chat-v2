export type McpServerSource = "owned" | "third-party";

export type RemoteMcpServerDefinition = {
  id: string;
  title: string;
  description: string;
  source: McpServerSource;
  connection: {
    transport: "http";
    url: string;
    headers?: Readonly<Record<string, string>>;
  };
};

export type McpServerSummary = Omit<
  RemoteMcpServerDefinition,
  "connection"
>;

export type McpServerRegistry = {
  list(): readonly McpServerSummary[];
  get(serverId: string): RemoteMcpServerDefinition;
};

export type McpServerEnvironment = {
  FORTUNE_MCP_URL?: string;
  FORTUNE_MCP_API_KEY?: string;
  BAIDU_MAPS_API_KEY?: string;
};

const SERVER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const BAIDU_MAPS_MCP_URL = "https://mcp.map.baidu.com/mcp";

function copyDefinition(
  definition: RemoteMcpServerDefinition,
): RemoteMcpServerDefinition {
  const url = new URL(definition.connection.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`MCP Server ${definition.id} 只允许 HTTP 远程连接`);
  }

  return {
    ...definition,
    connection: {
      ...definition.connection,
      url: url.toString(),
      ...(definition.connection.headers
        ? { headers: { ...definition.connection.headers } }
        : {}),
    },
  };
}

export function createMcpServerRegistry(
  definitions: readonly RemoteMcpServerDefinition[],
): McpServerRegistry {
  const servers = new Map<string, RemoteMcpServerDefinition>();

  for (const definition of definitions) {
    if (!SERVER_ID_PATTERN.test(definition.id)) {
      throw new Error(`无效的 MCP Server id: ${definition.id}`);
    }
    if (servers.has(definition.id)) {
      throw new Error(`重复的 MCP Server id: ${definition.id}`);
    }

    servers.set(definition.id, copyDefinition(definition));
  }

  return {
    list() {
      return [...servers.values()].map(
        ({ id, title, description, source }) => ({
          id,
          title,
          description,
          source,
        }),
      );
    },
    get(serverId) {
      const server = servers.get(serverId);
      if (!server) {
        throw new Error(`未知的 MCP Server: ${serverId}`);
      }

      return copyDefinition(server);
    },
  };
}

function readOptionalPair(
  environment: McpServerEnvironment,
  firstName: "FORTUNE_MCP_URL",
  secondName: "FORTUNE_MCP_API_KEY",
): [string, string] | undefined {
  const first = environment[firstName]?.trim();
  const second = environment[secondName]?.trim();

  if (!first && !second) {
    return undefined;
  }
  if (!first || !second) {
    throw new Error(`${firstName} 与 ${secondName} 必须同时配置`);
  }

  return [first, second];
}

export function createConfiguredMcpServerRegistry(
  environment: McpServerEnvironment,
): McpServerRegistry {
  const definitions: RemoteMcpServerDefinition[] = [];
  const fortune = readOptionalPair(
    environment,
    "FORTUNE_MCP_URL",
    "FORTUNE_MCP_API_KEY",
  );

  if (fortune) {
    const [url, apiKey] = fortune;
    definitions.push({
      id: "fortune",
      title: "传统文化与塔罗",
      description: "提供八字排盘、每日黄历和塔罗抽牌。",
      source: "owned",
      connection: {
        transport: "http",
        url,
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    });
  }

  const baiduMapsApiKey = environment.BAIDU_MAPS_API_KEY?.trim();
  if (baiduMapsApiKey) {
    const url = new URL(BAIDU_MAPS_MCP_URL);
    url.searchParams.set("ak", baiduMapsApiKey);
    definitions.push({
      id: "baidu-maps",
      title: "百度地图",
      description: "提供地点搜索、路线规划、天气和地理编码等地图能力。",
      source: "third-party",
      connection: { transport: "http", url: url.toString() },
    });
  }

  return createMcpServerRegistry(definitions);
}
