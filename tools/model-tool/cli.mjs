#!/usr/bin/env node
// 模型工具命令行入口：参数解析、路径校验、envelope 组装、退出码。
// stdout 只输出一个完整 JSON；日志一律走 stderr。
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, ToolError, envelope, diagnostic } from './lib/schema.mjs';
import { validateRequest } from './lib/contract.mjs';
import { describeGlbDeclared } from './lib/glb.mjs';
import {
  AUTHORIZED_OUTPUT_ROOT,
  modelRootOf,
  prepareOutDir,
  resolveInputFile,
  resolveOutFile,
  sha256File,
  writeNewFile,
} from './lib/paths.mjs';
import { renderRunCount, runRendererTask } from './lib/runner.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..', '..');
const GAME_ASSETS = join(PROJECT_ROOT, 'public', 'assets');
const TOOL_VERSION = '0.1.0';
const EXAMPLE_CHARACTER_DIR = join(GAME_ASSETS, 'models', 'character');
const exampleOut = (name) => `"${join(AUTHORIZED_OUTPUT_ROOT, 'model-tool-out', name)}"`;
const exampleModel = (name) => `"${join(EXAMPLE_CHARACTER_DIR, name)}"`;

const SUPPORTED_EXT = ['.glb', '.gltf', '.usdz'];

function log(message) {
  process.stderr.write(`[model-tool] ${message}\n`);
}

/* ------------------------------------------------------------------ 参数 */

const COMMANDS = {
  capabilities: {
    summary: '列出各格式与各命令的真实支持情况（不启动渲染进程）',
    args: [],
    example: 'node tools/model-tool/cli.mjs capabilities',
  },
  inspect: {
    summary: '只读检查模型：网格、材质、骨骼、片段、依赖、包围盒',
    args: [
      ['input', 'path', true, '模型绝对路径（.glb / .gltf / .usdz）'],
      ['out', 'path', true, '输出目录绝对路径（不存在则创建）'],
    ],
    example:
      `node tools/model-tool/cli.mjs inspect --input ${exampleModel('Casual_Male.glb')} --out ${exampleOut('inspect')}`,
  },
  snapshot: {
    summary: '按资产内片段与时间点渲染一张 PNG 与参数报告',
    args: [
      ['input', 'path', true, '模型绝对路径'],
      ['out', 'path', true, '输出目录绝对路径'],
      ['clip', 'string', false, '片段名；省略则截静止姿态'],
      ['time', 'number', false, '片段内秒数（默认 0，超出会被夹紧并诊断）'],
      ['yaw', 'number', false, '模型绕 Y 轴旋转角度（默认 0）'],
      ['width', 'number', false, '画布宽（默认 800）'],
      ['height', 'number', false, '画布高（默认 1000）'],
    ],
    example:
      `node tools/model-tool/cli.mjs snapshot --input ${exampleModel('Casual_Male.glb')} --out ${exampleOut('shot')} --clip Walk --time 0.4 --yaw 90`,
  },
  'snapshot-game-character': {
    summary: '用真实 CharacterRig 驱动语义动作并截图（静态多朝向 / 连续转向）',
    args: [
      ['out', 'path', true, '输出目录绝对路径'],
      ['action', 'string', false, 'idle|walk|run|jumpStart|airborne|land（默认 idle）'],
      ['time', 'number', false, '秒数：静态=模拟时长；转向=转向前预热（默认 0.5）'],
      ['yaw', 'number', false, '静态朝向角度（默认 0）'],
      ['angles', 'string', false, '静态多朝向，逗号分隔，如 0,90,180,270'],
      ['turn-from', 'number', false, '连续转向起始 yaw（度）；四个 turn-* 必须同时提供'],
      ['turn-to', 'number', false, '连续转向结束 yaw（度），按该数值方向线性插值'],
      ['turn-duration', 'number', false, '连续转向持续时间（秒，0 < t ≤ 10）'],
      ['turn-samples', 'string', false, '转向采样时间，逗号分隔，最多 17 个；实际时间量化到固定帧'],
      ['width', 'number', false, '画布宽（默认 720）'],
      ['height', 'number', false, '画布高（默认 900）'],
      ['scale-reference', 'flag', false, '叠加 1 m 刻度与地面网格参照'],
    ],
    example:
      `node tools/model-tool/cli.mjs snapshot-game-character --out ${exampleOut('char')} --action walk --angles 0,90,180,270`,
  },
  'animation-edit': {
    summary: '按秒裁剪/重命名片段并预览；仅 LINEAR/STEP，CUBICSPLINE 明确拒绝（C 包）',
    args: [
      ['input', 'path', true, 'glb/gltf 绝对路径（USDZ 明确不支持写回）'],
      ['out', 'path', true, '输出目录绝对路径'],
      ['clip', 'string', true, '源片段名'],
      ['rename', 'string', false, '新片段名'],
      ['start', 'number', false, '裁剪起点秒'],
      ['end', 'number', false, '裁剪终点秒'],
      ['write-glb', 'string', false, '派生 GLB 的相对输出路径，必须以 .glb 结尾'],
      ['confirm-write', 'flag', false, '确认写出派生资产（缺省只给计划）'],
    ],
    example:
      `node tools/model-tool/cli.mjs animation-edit --input ${exampleModel('Casual_Male.glb')} --out ${exampleOut('edit')} --clip Walk --start 0.2 --end 0.8`,
  },
  retarget: {
    summary: '报告两套骨架的映射候选与风险，不导出动画（C 包）',
    args: [
      ['source', 'path', true, '源模型绝对路径（作为 input）'],
      ['target', 'path', true, '目标模型绝对路径，必须与 source 同目录'],
      ['out', 'path', true, '输出目录绝对路径'],
      ['map', 'string', false, '显式映射 "srcBone=dstBone,..."'],
    ],
    example:
      `node tools/model-tool/cli.mjs retarget --source ${exampleModel('Casual_Male.glb')} --target ${exampleModel('Alina_Ip_Animated.usdz')} --out ${exampleOut('retarget')}`,
  },
  collision: {
    summary: '按真实碰撞输入绘制胶囊与静态碰撞盒（D 包，只读）',
    args: [
      ['out', 'path', true, '输出目录绝对路径'],
      ['focus', 'string', false, '聚焦点 "x,z"（米）'],
      ['width', 'number', false, '画布宽（默认 1280）'],
      ['height', 'number', false, '画布高（默认 800）'],
    ],
    example: `node tools/model-tool/cli.mjs collision --out ${exampleOut('collision')}`,
  },
  'collision-snapshot': {
    summary: '读取隔离 World 中真实 PhysicsRuntime/Rapier Collider 并出 JSON + PNG',
    args: [
      ['scene', 'string', false, 'outdoor 或 indoor；仅 --self-check 时可省略'],
      ['out', 'path', true, '输出目录绝对路径'],
      ['focus', 'string', false, '近景焦点 "x,z"（米）；省略用人物权威位置'],
      ['radius', 'number', false, '近景半径（米，默认室外 12 / 室内 4）'],
      ['width', 'number', false, '画布宽（默认 1280）'],
      ['height', 'number', false, '画布高（默认 800）'],
      ['self-check', 'flag', false, '隔离物理自检：RoundCuboid 快照/绘制与只读副本检查（不加载游戏场景）'],
    ],
    example: `node tools/model-tool/cli.mjs collision-snapshot --scene outdoor --out ${exampleOut('collision-snapshot')}`,
  },
};

const GLOBAL_HELP = `model-tool ${TOOL_VERSION} —— 无头模型检查与受控渲染

用法：
  node tools/model-tool/cli.mjs <command> [--key value ...]
  node tools/model-tool/cli.mjs <command> --help

命令：
${Object.entries(COMMANDS)
  .map(([name, spec]) => `  ${name.padEnd(24)} ${spec.summary}`)
  .join('\n')}

通用规则：
  - 所有路径必须是绝对路径；支持空格与中文路径（参数按数组传给进程，不拼 shell）
  - --out 必须位于授权工作区内：${AUTHORIZED_OUTPUT_ROOT}
  - --out 必须显式给出；已存在同名产物会失败，不隐式覆盖
  - stdout 只有一个 JSON envelope；进度写 stderr
  - 退出码：0 成功 / 2 参数 / 3 不支持 / 4 输入输出 / 5 处理失败 / 6 结果不完整
  - 输入只读；不访问网络；不接触游戏进程或玩家存档
`;

function commandHelp(name) {
  const spec = COMMANDS[name];
  const rows = spec.args
    .map(([key, type, required, desc]) => {
      const flag = type === 'flag' ? `--${key}` : `--${key} <${type}>`;
      return `  ${flag.padEnd(26)} ${required ? '必填' : '可选'}  ${desc}`;
    })
    .join('\n');
  return `用法：node tools/model-tool/cli.mjs ${name} [参数]

${spec.summary}

参数：
${rows || '  （无参数）'}

示例：
  ${spec.example}

输出：单个 JSON envelope（schemaVersion 1），产物写在 --out 目录；
      报告为 report.json，退出码见 --help 全局说明。
`;
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw new ToolError('ARG_UNEXPECTED', `无法识别的参数：${token}`, EXIT.BAD_ARGUMENTS);
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      values.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.add(body);
      continue;
    }
    values.set(body, next);
    index += 1;
  }
  return { values, flags };
}

function coerceArgs(name, parsed) {
  const spec = COMMANDS[name];
  const args = {};
  const known = new Map(spec.args.map((item) => [item[0], item]));
  for (const key of [...parsed.values.keys(), ...parsed.flags]) {
    if (!known.has(key)) {
      throw new ToolError('ARG_UNKNOWN', `未知参数 --${key}（见 ${name} --help）`, EXIT.BAD_ARGUMENTS);
    }
  }
  for (const [key, type, required] of spec.args) {
    if (type === 'flag') {
      if (required && !parsed.flags.has(key)) {
        throw new ToolError('ARG_REQUIRED', `缺少必填参数 --${key}`, EXIT.BAD_ARGUMENTS);
      }
      if (parsed.flags.has(key)) args[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
      continue;
    }
    const raw = parsed.values.get(key);
    if (raw === undefined) {
      if (required) throw new ToolError('ARG_REQUIRED', `缺少必填参数 --${key}`, EXIT.BAD_ARGUMENTS);
      continue;
    }
    if (type === 'number') {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new ToolError('ARG_NUMBER', `--${key} 必须是数字：${raw}`, EXIT.BAD_ARGUMENTS);
      }
      args[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    } else {
      args[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = raw;
    }
  }
  return args;
}

/* -------------------------------------------------------------- 能力矩阵 */

function capabilities() {
  // status 取值：
  //   verified    本机实际跑通并有产物
  //   implemented 代码已实现，但本轮预算内未实跑
  //   unsupported 明确不支持
  const formats = {
    glb: {
      read: 'verified',
      snapshot: 'verified',
      animationEdit: 'verified',
      writeBack: 'verified（仅 LINEAR/STEP；CUBICSPLINE 明确拒绝，GLB 重新序列化，需 --confirm-write）',
      note:
        'Casual_Male.glb 实跑：读、裁剪、重命名、导出均通过；apet.glb（60 张内嵌 PNG/JPEG、105 骨骼）inspect 与 snapshot 实跑，贴图 60/60 加载成功；CUBICSPLINE/特殊插值拒绝编辑',
    },
    gltf: {
      read: 'verified',
      snapshot: 'verified',
      animationEdit: 'implemented',
      writeBack: 'implemented（仅 LINEAR/STEP；CUBICSPLINE 明确拒绝，GLB 重新序列化，需 --confirm-write）',
      note:
        '相对依赖必须位于模型所在目录；越界与远程引用被拒绝。本轮用本地最小 glTF + 同目录 PNG 实测 snapshot（贴图可见、0 失败）；损坏图片与被 CSP 阻止的远程图片都返回 partial 并给出对应诊断',
    },
    usdz: {
      read: 'verified',
      snapshot: 'verified',
      animationEdit: 'unsupported',
      writeBack: 'unsupported',
      note: 'three USDLoader（含二进制 USDC 解析）；没有无损写回证明，不提供导出',
    },
  };
  const commands = [
    ['capabilities', 'verified', '列出各格式与各命令的真实支持情况（不启动渲染进程）'],
    ['inspect', 'verified', '只读检查模型：网格、材质、骨骼、片段、依赖、包围盒'],
    ['snapshot', 'verified', '按资产内片段与时间点渲染一张 PNG 与参数报告'],
    ['snapshot-game-character', 'verified', '真实 CharacterRig：静态多朝向（每 yaw 独立重演）与连续转向（每帧先设朝向再 update）'],
    ['animation-edit', 'verified', '按秒裁剪/重命名片段并预览；仅 LINEAR/STEP；CUBICSPLINE 明确拒绝（C 包）'],
    ['retarget', 'implemented', '报告两套骨架的映射候选与风险，不导出动画（C 包）'],
    ['collision', 'verified', '按真实碰撞输入绘制胶囊与静态碰撞盒（D 包，只读）'],
    ['collision-snapshot', 'implemented', '隔离 World 的真实 PhysicsRuntime/Rapier Collider 快照（D 包，只读）；--self-check 本轮实测'],
  ].map(([command, status, summary]) => ({
    command,
    status,
    summary,
    spawnsRenderer: command !== 'capabilities',
  }));
  return {
    formats,
    commands,
    runtime: {
      renderer: 'electron hidden window + custom modeltool:// protocol',
      electron: '45.2.1',
      three: '0.186.1',
      isolation: 'sandbox + contextIsolation + nodeIntegration=false + webSecurity=true',
      network: 'CSP default-src none + 协议白名单，工具不下发任何网络请求',
    },
    unsupported: [
      'USDZ 写回 / 派生资产',
      'CUBICSPLINE 与 Smooth/Bezier/未知自定义插值的动作裁剪与导出',
      '任意 URL 与远程贴图下载',
      '跨目录依赖与软链接越界',
      '当前项目目录的父目录之外的持久输出',
      'retarget 的动画导出（只出映射与风险报告）',
      '源模型有资源加载失败时的派生 GLB 导出（明确拒绝，避免丢失贴图/几何）',
      '运行中 Rapier 世界的逐项碰撞快照（见 collision 的 parity 说明）',
    ],
    countsToward: '每次命令（除 capabilities/--help）启动一个隔离 Electron 进程；不触碰游戏进程与玩家存档',
  };
}

/* ------------------------------------------------------------------ 主流程 */

async function buildRequest(command, args) {
  const out = args.out;
  if (typeof out !== 'string') {
    throw new ToolError('ARG_REQUIRED', '缺少必填参数 --out', EXIT.BAD_ARGUMENTS);
  }
  const outDir = await prepareOutDir(out);

  let input = null;
  let inputSha256 = null;
  let inputSize = null;
  let allowedRoot = null;
  let declaredResources = null;

  const needsInput = command === 'inspect' || command === 'snapshot' || command === 'animation-edit';
  const inputValue = command === 'retarget' ? args.source : args.input;

  if (needsInput || command === 'retarget') {
    const resolved = await resolveInputFile(command === 'retarget' ? '--source' : '--input', inputValue);
    const ext = resolved.realPath.slice(resolved.realPath.lastIndexOf('.')).toLowerCase();
    if (!SUPPORTED_EXT.includes(ext)) {
      throw new ToolError(
        'FORMAT_UNSUPPORTED',
        `不支持的模型扩展名：${ext || '(无扩展名)'}；当前只读取 ${SUPPORTED_EXT.join(' / ')}`,
        EXIT.UNSUPPORTED,
      );
    }
    input = resolved.realPath;
    inputSize = resolved.size;
    inputSha256 = await sha256File(resolved.realPath);
    allowedRoot = modelRootOf(resolved.realPath);

    // GLB 的「声明资源」在 Node 侧只读头 + JSON chunk 得出，不把模型字节复制进渲染进程。
    // .gltf 由渲染页读取自身 JSON；.usdz 无法可靠枚举，保持 unavailable。
    if (command !== 'retarget' && input.toLowerCase().endsWith('.glb')) {
      declaredResources = await describeGlbDeclared(input);
      if (declaredResources.source === 'unavailable') {
        log(`GLB 声明资源不可用：${declaredResources.notes[0] ?? '未知原因'}`);
      }
    }
  }

  if (command === 'retarget') {
    if (typeof args.target !== 'string') {
      throw new ToolError('ARG_REQUIRED', '缺少必填参数 --target', EXIT.BAD_ARGUMENTS);
    }
    const target = await resolveInputFile('--target', args.target);
    const targetDir = modelRootOf(target.realPath);
    if (targetDir !== allowedRoot) {
      throw new ToolError(
        'RETARGET_DIR_MISMATCH',
        '--target 必须与 --source 在同一目录（工具只授权模型所在目录）',
        EXIT.IO,
        { sourceDir: allowedRoot, targetDir },
      );
    }
    const ext = target.realPath.slice(target.realPath.lastIndexOf('.')).toLowerCase();
    if (!SUPPORTED_EXT.includes(ext)) {
      throw new ToolError('FORMAT_UNSUPPORTED', `--target 扩展名不支持：${ext}`, EXIT.UNSUPPORTED);
    }
    args.target = target.realPath;
  }

  // 报告名冲突检查：提前失败，避免白跑一次渲染进程。
  await resolveOutFile(outDir.realPath, 'report.json', outDir.authorizedRootReal).then(async (target) => {
    const info = await stat(target.absolute).catch(() => null);
    if (info) {
      throw new ToolError('OUTPUT_EXISTS', `输出目录已有 report.json，拒绝覆盖：${target.absolute}`, EXIT.IO);
    }
  });

  return {
    outDir,
    request: {
      schemaVersion: 1,
      command,
      input,
      inputSha256,
      inputSize,
      outDir: outDir.realPath,
      args,
      allowedRoot,
      authorizedRoot: outDir.authorizedRootReal,
      declaredResources,
      toolVersion: TOOL_VERSION,
      gameAssetsDir: GAME_ASSETS,
      projectRoot: PROJECT_ROOT,
    },
  };
}

async function runCommand(command, argv) {
  const parsed = parseArgs(argv);
  const args = coerceArgs(command, parsed);
  const startedAt = Date.now();
  const { outDir, request } = await buildRequest(command, args);
  validateRequest(request);
  log(`启动隔离渲染进程：${command}（第 ${renderRunCount() + 1} 次）`);

  const { result, durationMs, stderrTail } = await runRendererTask({ request });
  if (stderrTail.trim() !== '' && result.status !== 'ok') {
    log(`渲染进程 stderr 尾部：\n${stderrTail.slice(-1200)}`);
  }

  // outputs 只列出真实写出的文件：渲染进程回报的写入来自主进程 `wx` 落盘，
  // 报告只有在本进程成功写完后才追加。
  const outputs = [...(result.outputs ?? [])];
  const reportTarget = await resolveOutFile(
    outDir.realPath,
    'report.json',
    outDir.authorizedRootReal,
  );

  const exitCode =
    result.status === 'ok'
      ? EXIT.OK
      : result.status === 'partial'
        ? EXIT.PARTIAL
        : result.error?.exitCode ?? EXIT.FAILED;

  const diagnostics = [...(result.diagnostics ?? [])];
  const metadata = {
    toolVersion: TOOL_VERSION,
    node: process.version,
    rendererRuns: 1,
    durationMs: Date.now() - startedAt,
    rendererDurationMs: durationMs,
    ...(result.metadata ?? {}),
  };
  const inputs = {
    input: request.input,
    inputSha256: request.inputSha256,
    inputSize: request.inputSize,
    outDir: request.outDir,
    args,
  };
  const buildBody = (status, outs, diags, data) =>
    envelope({ command, status, inputs, outputs: outs, diagnostics: diags, metadata, data });

  let body;
  if (exitCode === EXIT.OK || exitCode === EXIT.PARTIAL) {
    const reportEntry = { path: reportTarget.absolute, type: 'report', sha256: null };
    const withReport = [...outputs, reportEntry];
    const text = `${JSON.stringify(buildBody(result.status, withReport, diagnostics, result.data), null, 2)}\n`;
    try {
      await writeNewFile(reportTarget.absolute, text);
    } catch (error) {
      // 报告没写出来就不能把 ok/partial 交出去，也不能声称报告路径存在。
      const failure = error instanceof ToolError ? error : null;
      const message = failure ? failure.message : String(error?.message ?? error);
      const failureBody = buildBody(
        'error',
        outputs,
        [...diagnostics, diagnostic('REPORT_WRITE_FAILED', 'error', `报告写入失败：${message}`, {
          path: reportTarget.absolute,
        })],
        null,
      );
      log(`报告写入失败：${message}`);
      process.stdout.write(`${JSON.stringify(failureBody)}\n`);
      return failure ? failure.exitCode : EXIT.FAILED;
    }
    body = buildBody(result.status, withReport, diagnostics, result.data);
  } else {
    // error：不写报告，也不把不存在的 report.json 加入 outputs。
    body = buildBody(result.status, outputs, diagnostics, result.data);
  }

  process.stdout.write(`${JSON.stringify(body)}\n`);
  return exitCode;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === 'help') {
    process.stdout.write(GLOBAL_HELP);
    return EXIT.OK;
  }
  const command = argv[0];
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, command)) {
    throw new ToolError('COMMAND_UNKNOWN', `未知命令：${command}`, EXIT.BAD_ARGUMENTS);
  }
  if (argv.includes('--help')) {
    process.stdout.write(commandHelp(command));
    return EXIT.OK;
  }
  if (command === 'capabilities') {
    const body = envelope({
      command,
      status: 'ok',
      inputs: {},
      outputs: [],
      diagnostics: [
        diagnostic('CAPABILITIES_STATIC', 'info', '能力清单为静态声明；verified 字段表示是否已在本机实际跑通'),
      ],
      metadata: { toolVersion: TOOL_VERSION, node: process.version, rendererRuns: 0 },
      data: capabilities(),
    });
    process.stdout.write(`${JSON.stringify(body)}\n`);
    return EXIT.OK;
  }
  return runCommand(command, argv.slice(1));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof ToolError) {
      const body = envelope({
        command: process.argv[2] ?? null,
        status: 'error',
        inputs: {},
        outputs: [],
        diagnostics: [
          diagnostic(error.code, 'error', error.message, error.details ?? undefined),
        ],
        metadata: { toolVersion: TOOL_VERSION, node: process.version },
        data: null,
      });
      process.stderr.write(`${error.message}\n`);
      process.stdout.write(`${JSON.stringify(body)}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    log(`未捕获异常：${error && error.stack ? error.stack : String(error)}`);
    process.exitCode = EXIT.FAILED;
  });
