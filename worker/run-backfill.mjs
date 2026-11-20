import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const python = existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3';
const child = spawn(python, ['worker/backfill_news.py', ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
child.on('error', () => { console.error('Unable to start Python. Check your local Python environment.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
