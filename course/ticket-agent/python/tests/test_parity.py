import json
import shutil
import subprocess
import unittest
from dataclasses import asdict
from pathlib import Path

from ticket_agent.evaluate import EVAL_CASES
from ticket_agent.seed import DOCUMENTS, USERS

PROJECT = Path(__file__).resolve().parents[2]
SCRIPT = (
    "import {documents, users} from './src/data/seed.ts';"
    "import {evalCases} from './src/eval/cases.ts';"
    'console.log(JSON.stringify({documents, users, evalCases}));'
)


@unittest.skipUnless(shutil.which('node'), '没有安装 Node.js，跳过与 TS 版的比对')
class ParityWithTypeScriptTest(unittest.TestCase):
    """种子数据和评测用例在两种语言里各有一份，这里逐字段比对，防止一边改了另一边没改。"""

    def test_seed_and_eval_cases_match_the_typescript_source(self):
        output = subprocess.run(['node', '--input-type=module', '-e', SCRIPT], cwd=PROJECT, capture_output=True,
                                check=True, encoding='utf-8').stdout
        ts = json.loads(output)

        def camel(record: dict) -> dict:
            renamed = {'tenant_id': 'tenantId', 'allowed_roles': 'allowedRoles'}
            return {renamed.get(k, k): list(v) if isinstance(v, tuple) else v for k, v in record.items()}

        self.assertEqual([camel(asdict(d)) for d in DOCUMENTS], ts['documents'])
        self.assertEqual([camel(asdict(u)) for u in USERS], ts['users'])
        self.assertEqual(EVAL_CASES, ts['evalCases'])
