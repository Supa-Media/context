describe('landing MCP endpoint follows the deployed environment', () => {
  const before = process.env.EXPO_PUBLIC_MCP_URL;
  afterEach(() => {
    if (before === undefined) delete process.env.EXPO_PUBLIC_MCP_URL;
    else process.env.EXPO_PUBLIC_MCP_URL = before;
    jest.resetModules();
  });
  it('copies the staging endpoint on the staging app', () => {
    process.env.EXPO_PUBLIC_MCP_URL = 'https://mcp-staging.context.lc/mcp';
    jest.resetModules();
    expect(require('../features/landing/copy').ENDPOINT_HOST).toBe('mcp-staging.context.lc/@you');
  });
  it('keeps the production endpoint when no override is configured', () => {
    delete process.env.EXPO_PUBLIC_MCP_URL;
    jest.resetModules();
    expect(require('../features/landing/copy').ENDPOINT_HOST).toBe('mcp.context.lc/@you');
  });
});
