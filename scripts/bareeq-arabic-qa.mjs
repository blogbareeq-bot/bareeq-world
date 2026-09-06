#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  compareProtectedTokens,
  discoverMarkdownFiles,
  loadConfig,
  renderMarkdownReport,
  runLanguageTool,
  scanArticle,
  summarize
} from './bareeq-arabic-qa-core.mjs';

const root = path.resolve('.');
const args = parseArgs(process.argv.slice(2));
const configPath = path.resolve(root, args.config ?? 'config/bareeq-arabic-qa.json');
const config = await loadConfig(configPath);
const files = await resolveFiles({ root, config, args });

if (!files.length) {
  console.log('Bareeq Arabic QA: no matching Markdown files; PASS.');
  process.exit(0);
}

const findings = [];
const providerStatus = {
  'bareeq-core': 'ran',
  'bareeq-style': 'ran',
  'bareeq-semantic-guard': args.baseRef ? 'ran-on-comparable-files' : 'skipped-no-base-ref',
  languagetool: args.languageTool ? (process.env.BAREEQ_LT_URL ? 'ran' : 'skipped-no-endpoint') : 'skipped-not-requested',
  'camel-tools': 'separate-advisory-script',
  'arab-writer': process.env.BAREEQ_ARAB_WRITER_COMMAND ? 'external-hook-configured-outside-core' : 'report-only-not-configured'
};

for (const absFile of files) {
  const relFile = path.relative(root, absFile).replaceAll('\\', '/');
  const source = await readFile(absFile, 'utf8');
  findings.push(...scanArticle({ file: relFile, source, config }));

  if (args.baseRef) {
    const baseSource = readFileAtGitRef(args.baseRef, relFile);
    if (baseSource !== null) {
      findings.push(...compareProtectedTokens({
        file: relFile,
        baseSource,
        headSource: source,
        strict: args.strictProtected
      }));
    }
  }

  if (args.languageTool && process.env.BAREEQ_LT_URL) {
    findings.push(...await runLanguageTool({
      file: relFile,
      source,
      config,
      endpoint: process.env.BAREEQ_LT_URL,
      strict: process.env.BAREEQ_LT_STRICT === '1'
    }));
  }
}

const summary = summarize(findings, files.length);
const generatedAt = new Date().toISOString();
const report = {
  schemaVersion: 1,
  gateVersion: config.gateVersion,
  generatedAt,
  configPath: path.relative(root, configPath).replaceAll('\\', '/'),
  mode: args.changed ? 'changed' : 'all',
  baseRef: args.baseRef ?? null,
  providerStatus,
  summary,
  findings
};
const markdown = renderMarkdownReport({ summary, findings, gateVersion: config.gateVersion, generatedAt });

if (!args.noWrite) {
  const reportDir = path.resolve(root, args.reportDir ?? '.bareeq/qa');
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, 'bareeq-arabic-qa.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(path.join(reportDir, 'bareeq-arabic-qa.md'), markdown, 'utf8');
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n${markdown}\n`, 'utf8');
  }
}

printConsoleSummary(summary, findings);
process.exit(summary.passed ? 0 : 1);

function parseArgs(argv) {
  const out = {
    all: false,
    changed: false,
    baseRef: null,
    reportDir: null,
    config: null,
    noWrite: false,
    strictProtected: false,
    languageTool: false,
    files: []
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') out.all = true;
    else if (arg === '--changed') out.changed = true;
    else if (arg === '--base-ref') out.baseRef = requireValue(argv, ++i, '--base-ref');
    else if (arg === '--report-dir') out.reportDir = requireValue(argv, ++i, '--report-dir');
    else if (arg === '--config') out.config = requireValue(argv, ++i, '--config');
    else if (arg === '--file') out.files.push(requireValue(argv, ++i, '--file'));
    else if (arg === '--no-write') out.noWrite = true;
    else if (arg === '--strict-protected') out.strictProtected = true;
    else if (arg === '--language-tool') out.languageTool = true;
    else if (arg === '--help' || arg === '-h') printHelpAndExit();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.all && !out.changed && !out.files.length) out.all = true;
  if (out.changed && !out.baseRef) throw new Error('--changed requires --base-ref <git-ref>.');
  return out;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

async function resolveFiles({ root, config, args }) {
  if (args.files.length) {
    return args.files.map((file) => path.resolve(root, file));
  }
  if (args.changed) {
    const diff = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${args.baseRef}...HEAD`, '--', ...config.contentRoots], {
      cwd: root,
      encoding: 'utf8'
    });
    return diff
      .split(/\r?\n/u)
      .map((item) => item.trim())
      .filter((item) => /\.mdx?$/iu.test(item))
      .map((item) => path.resolve(root, item));
  }
  return discoverMarkdownFiles(root, config.contentRoots);
}

function readFileAtGitRef(ref, relFile) {
  try {
    return execFileSync('git', ['show', `${ref}:${relFile}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function printConsoleSummary(summary, findings) {
  console.log(`Bareeq Arabic Quality Gate: ${summary.passed ? 'PASS' : 'FAIL'}`);
  console.log(`Files: ${summary.filesScanned} | Errors: ${summary.counts.error} | Warnings: ${summary.counts.warning} | Info: ${summary.counts.info}`);
  const blocking = findings.filter((item) => item.severity === 'error' || item.severity === 'fatal');
  for (const finding of blocking.slice(0, 25)) {
    console.error(`- [${finding.ruleId}] ${finding.file}${finding.line ? `:${finding.line}` : ''} — ${finding.message}`);
  }
  if (blocking.length > 25) console.error(`- … and ${blocking.length - 25} more blocking finding(s).`);
}

function printHelpAndExit() {
  console.log(`Bareeq Arabic Quality Gate\n\nUsage:\n  node scripts/bareeq-arabic-qa.mjs --all\n  node scripts/bareeq-arabic-qa.mjs --changed --base-ref origin/main\n\nOptions:\n  --all                 Scan all configured article Markdown files.\n  --changed             Scan only changed article files versus --base-ref.\n  --base-ref <ref>      Git base ref; also enables protected-token semantic guard.\n  --strict-protected    Make protected token changes blocking instead of advisory.\n  --language-tool       Run LanguageTool when BAREEQ_LT_URL is configured.\n  --file <path>         Scan a specific file; repeatable.\n  --report-dir <dir>    Report output directory (default .bareeq/qa).\n  --no-write            Do not write reports; useful inside existing build gates.\n  --config <path>       Config path.\n`);
  process.exit(0);
}
