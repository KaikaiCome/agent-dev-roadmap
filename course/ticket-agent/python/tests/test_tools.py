import unittest

from ticket_agent.seed import DOCUMENTS, find_user
from ticket_agent.tools import ToolError, knowledge_tool, search_documents, snippet_around, ticket_tools, visible_documents
from ticket_agent.store import Store


class PermissionFilterTest(unittest.TestCase):
    def test_filters_by_tenant_status_and_role_before_scoring(self):
        alice, carol, bob = find_user('alice'), find_user('carol'), find_user('bob')
        alice_ids = {f'{d.id}@v{d.version}' for d in visible_documents(DOCUMENTS, alice)}
        self.assertNotIn('acme-travel@v1', alice_ids)  # 已废止
        self.assertNotIn('acme-budget@v1', alice_ids)  # 角色不够
        self.assertNotIn('globex-travel@v1', alice_ids)  # 别的租户
        self.assertIn('acme-budget@v1', {f'{d.id}@v{d.version}' for d in visible_documents(DOCUMENTS, carol)})
        self.assertEqual({d.tenant_id for d in visible_documents(DOCUMENTS, bob)}, {'globex'})

    def test_same_question_returns_only_the_users_own_documents(self):
        question = '出差住宿每晚能报销多少钱？'
        self.assertEqual([h['sourceId'] for h in search_documents(DOCUMENTS, find_user('alice'), question)], ['acme-travel@v2'])
        self.assertEqual([h['sourceId'] for h in search_documents(DOCUMENTS, find_user('bob'), question)], ['globex-travel@v1'])
        self.assertEqual(search_documents(DOCUMENTS, find_user('alice'), 'Q4 部门预算冻结了吗？'), [])

    def test_snippet_is_cut_around_the_first_hit_in_long_documents(self):
        content = '无关内容。' * 60 + '婚假 3 天。' + '其他内容。' * 60
        snippet = snippet_around(content, {'婚假': None})
        self.assertTrue(snippet.startswith('…') and snippet.endswith('…'))
        self.assertIn('婚假 3 天', snippet)


class ToolArgumentTest(unittest.TestCase):
    def test_rejects_invalid_arguments_with_tool_errors(self):
        search = knowledge_tool()
        with self.assertRaises(ToolError):
            search.parse(['not', 'an', 'object'])
        with self.assertRaises(ToolError):
            search.parse({'query': '  '})
        with self.assertRaises(ToolError):
            search.parse({'query': 'x' * 201})
        store = Store()
        try:
            prepare, _ = ticket_tools(store)
            with self.assertRaises(ToolError):
                prepare.parse({'title': 't', 'description': 'd', 'sourceIds': [1]})
            self.assertEqual(prepare.parse({'title': ' t ', 'description': 'd'})['title'], 't')
        finally:
            store.close()
