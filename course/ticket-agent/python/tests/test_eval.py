import unittest

from ticket_agent.evaluate import EVAL_CASES, CaseResult, gate, run_case
from ticket_agent.mock import MockModel, ScriptedModel
from ticket_agent.seed import DOCUMENTS


def result(case_id: str, passed: bool, critical: bool = False) -> CaseResult:
    return CaseResult(case_id, critical, passed, [] if passed else ['x'], 'completed', 10, 5, 1)


class EvalGateTest(unittest.IsolatedAsyncioTestCase):
    async def test_all_cases_pass_with_the_offline_model(self):
        results = [await run_case(case, MockModel()) for case in EVAL_CASES]
        self.assertEqual([r.failures for r in results if not r.passed], [])
        report = gate(results)
        self.assertTrue(report.passed)
        self.assertEqual(report.pass_rate, 1)

    def test_a_single_critical_failure_blocks_release_regardless_of_pass_rate(self):
        results = [result(f'ok-{i}', True) for i in range(19)] + [result('tenant-isolation', False, critical=True)]
        report = gate(results)
        self.assertEqual(report.pass_rate, 0.95)
        self.assertFalse(report.passed)
        self.assertEqual(report.critical_failures, ['tenant-isolation'])
        self.assertFalse(gate([result('a', True), result('b', False)]).passed)

    async def test_detects_leaked_chinese_text_in_tool_results(self):
        # 故意写一个不过滤权限的检索：评测必须发现越权内容出现在了工具结果里。
        # 如果序列化用了 json.dumps 默认的 ensure_ascii=True，中文变成 \\uXXXX，这条检查会悄悄失效
        def leaky(user, query):
            return [{'sourceId': f'{d.id}@v{d.version}', 'title': d.title, 'snippet': d.content, 'score': 9}
                    for d in DOCUMENTS if d.id == 'acme-budget']

        case = next(c for c in EVAL_CASES if c['id'] == 'role-acl-denied')
        # 模型没有把泄露内容说出来，只有工具结果里有
        model = ScriptedModel([{'tool_calls': [{'name': 'search_knowledge', 'args': {'query': case['question']}}]},
                               {'content': '无法确认，建议咨询财务部门。'}])
        leaked = await run_case(case, model, search=leaky)
        self.assertFalse(leaked.passed)
        self.assertIn('出现了不该出现的内容「冻结，新增采购」', leaked.failures)
