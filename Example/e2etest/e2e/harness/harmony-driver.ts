import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HDC = process.env.HDC_PATH || 'hdc';
const DEVICE_LAYOUT_PATH = '/data/local/tmp/e2e-layout.json';

export interface UiNode {
  type: string;
  id: string;
  text: string;
  bounds: { left: number; top: number; right: number; bottom: number } | null;
  center: { x: number; y: number } | null;
  attributes: Record<string, string>;
}

export interface WaitOptions {
  timeout?: number;
  interval?: number;
  description?: string;
}

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_INTERVAL = 1000;

function parseBounds(raw: string | undefined): UiNode['bounds'] {
  const match = raw?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!match) {
    return null;
  }
  const [left, top, right, bottom] = match.slice(1).map(Number);
  return { left, top, right, bottom };
}

function flattenLayout(root: any): UiNode[] {
  const nodes: UiNode[] = [];
  const walk = (node: any) => {
    const attributes: Record<string, string> = node?.attributes ?? {};
    const bounds = parseBounds(attributes.bounds);
    nodes.push({
      type: attributes.type ?? '',
      id: attributes.id ?? '',
      text: attributes.text ?? '',
      bounds,
      center: bounds
        ? {
            x: Math.round((bounds.left + bounds.right) / 2),
            y: Math.round((bounds.top + bounds.bottom) / 2),
          }
        : null,
      attributes,
    });
    for (const child of node?.children ?? []) {
      walk(child);
    }
  };
  walk(root);
  return nodes;
}

function area(node: UiNode): number {
  if (!node.bounds) {
    return Number.MAX_SAFE_INTEGER;
  }
  return (
    (node.bounds.right - node.bounds.left) *
    (node.bounds.bottom - node.bounds.top)
  );
}

export class HarmonyDriver {
  constructor(
    readonly bundleName: string,
    readonly abilityName = 'EntryAbility',
    readonly target = process.env.HDC_TARGET || '',
  ) {}

  async hdc(...args: string[]): Promise<string> {
    const fullArgs = this.target ? ['-t', this.target, ...args] : args;
    const { stdout } = await execFileAsync(HDC, fullArgs, {
      maxBuffer: 16 * 1024 * 1024,
      // A half-disconnected device can hang hdc indefinitely; fail the single
      // call fast instead of eating the whole 300s jest timeout with no
      // pointer to the culprit.
      timeout: 15_000,
    });
    return stdout;
  }

  shell(command: string): Promise<string> {
    return this.hdc('shell', command);
  }

  static async listTargets(): Promise<string[]> {
    const { stdout } = await execFileAsync(HDC, ['list', 'targets']);
    return stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && line !== '[Empty]');
  }

  async launch(): Promise<void> {
    const output = await this.shell(
      `aa start -b ${this.bundleName} -a ${this.abilityName}`,
    );
    if (!output.includes('successfully')) {
      throw new Error(`Failed to launch ${this.bundleName}: ${output.trim()}`);
    }
  }

  async terminate(): Promise<void> {
    await this.shell(`aa force-stop ${this.bundleName}`);
  }

  // Keeps app data, matching Detox's launchApp({ newInstance: true }).
  async relaunch(): Promise<void> {
    await this.terminate();
    await this.launch();
  }

  async installHap(hapPath: string): Promise<void> {
    const output = await this.hdc('install', '-r', hapPath);
    if (!/successfully/i.test(output)) {
      throw new Error(`hdc install failed: ${output.trim()}`);
    }
  }

  async uninstall(): Promise<void> {
    await this.hdc('uninstall', this.bundleName);
  }

  async rport(devicePort: number, hostPort: number): Promise<void> {
    const spec = `tcp:${devicePort} tcp:${hostPort}`;
    const existing = await this.hdc('fport', 'ls');
    if (existing.includes(spec)) {
      return;
    }
    const output = await this.hdc(
      'rport',
      `tcp:${devicePort}`,
      `tcp:${hostPort}`,
    );
    // "listen failed" means the device side is already bound, i.e. the
    // mapping is effectively in place.
    if (!/OK/i.test(output) && !/listen failed/i.test(output)) {
      throw new Error(`hdc rport failed: ${output.trim()}`);
    }
  }

  async dumpLayout(): Promise<UiNode[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const dumpOutput = await this.shell(
          `uitest dumpLayout -p ${DEVICE_LAYOUT_PATH}`,
        );
        if (!dumpOutput.includes('DumpLayout saved')) {
          throw new Error(`uitest dumpLayout failed: ${dumpOutput.trim()}`);
        }
        const raw = await this.shell(`cat ${DEVICE_LAYOUT_PATH}`);
        return flattenLayout(JSON.parse(raw));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  // RNOH maps the RN `testID` prop to the ArkUI node id; nodes without a
  // testID get an auto-assigned numeric tag instead.
  async findById(testID: string): Promise<UiNode | undefined> {
    const nodes = await this.dumpLayout();
    return nodes.filter(node => node.id === testID).sort((a, b) => area(a) - area(b))[0];
  }

  async findByText(matcher: string | RegExp): Promise<UiNode | undefined> {
    const nodes = await this.dumpLayout();
    const matches = nodes.filter(node =>
      typeof matcher === 'string'
        ? node.text.includes(matcher)
        : matcher.test(node.text),
    );
    return matches.sort((a, b) => area(a) - area(b))[0];
  }

  async waitFor<T>(
    probe: () => Promise<T | undefined>,
    { timeout = DEFAULT_TIMEOUT, interval = DEFAULT_INTERVAL, description = 'condition' }: WaitOptions = {},
  ): Promise<T> {
    const deadline = Date.now() + timeout;
    let lastError: unknown;
    for (;;) {
      try {
        const result = await probe();
        if (result !== undefined) {
          return result;
        }
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeout}ms waiting for ${description}` +
            (lastError ? ` (last error: ${lastError})` : ''),
        );
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }

  waitForById(testID: string, options: WaitOptions = {}): Promise<UiNode> {
    return this.waitFor(() => this.findById(testID), {
      description: `element with testID "${testID}"`,
      ...options,
    });
  }

  waitForByText(
    matcher: string | RegExp,
    options: WaitOptions = {},
  ): Promise<UiNode> {
    return this.waitFor(() => this.findByText(matcher), {
      description: `element with text ${matcher}`,
      ...options,
    });
  }

  async tapNode(node: UiNode): Promise<void> {
    if (!node.center) {
      throw new Error(`Node ${node.id || node.text} has no tappable bounds`);
    }
    const output = await this.shell(
      `uitest uiInput click ${node.center.x} ${node.center.y}`,
    );
    // uitest prints "No Error" on success.
    if (!/no error/i.test(output) && /error|fail/i.test(output)) {
      throw new Error(`uiInput click failed: ${output.trim()}`);
    }
  }

  async tapById(testID: string, options: WaitOptions = {}): Promise<void> {
    await this.tapNode(await this.waitForById(testID, options));
  }

  async tapByText(
    matcher: string | RegExp,
    options: WaitOptions = {},
  ): Promise<void> {
    await this.tapNode(await this.waitForByText(matcher, options));
  }

  async screenshot(localPath: string): Promise<void> {
    const devicePath = '/data/local/tmp/e2e-screen.jpeg';
    await this.shell(`snapshot_display -f ${devicePath}`);
    await this.hdc('file', 'recv', devicePath, localPath);
  }
}
