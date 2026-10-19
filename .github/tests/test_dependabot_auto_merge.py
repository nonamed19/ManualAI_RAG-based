"""Exercise the workflow's actual inline code without a token or network calls."""
import copy
import io
import os
from pathlib import Path
import tempfile
import textwrap
import unittest
from unittest.mock import Mock, patch


WORKFLOW = Path(__file__).resolve().parents[1] / 'workflows/dependabot-auto-merge.yml'
CODE = textwrap.dedent(WORKFLOW.read_text(encoding='utf-8').split('        run: |\n', 1)[1])
REPO = 'example/manual-ai'


class AutoMergeTests(unittest.TestCase):
    def setUp(self):
        self.scope = {'__name__': 'workflow_test'}
        with patch.dict(os.environ, GH_REPO=REPO):
            exec(compile(CODE, str(WORKFLOW), 'exec'), self.scope)
        self.pr = {
            'number': 13, 'state': 'open', 'draft': False,
            'user': {'login': 'dependabot[bot]'},
            'head': {'repo': {'full_name': REPO}, 'sha': 'head-sha'},
            'base': {'repo': {'full_name': REPO}},
            'mergeable': True, 'mergeable_state': 'clean', 'auto_merge': None,
        }
        self.api = Mock()
        self.gh = Mock()
        self.scope.update(api=self.api, gh=self.gh)

    def reconcile(self, *states):
        self.api.side_effect = states
        return self.scope['reconcile'](13)

    def test_merge_matches_verified_head(self):
        result = self.reconcile(self.pr, {**self.pr, 'merged': True})
        self.assertEqual(result, 'Merged (squash)')
        self.gh.assert_called_once_with(
            'pr', 'merge', '13', '--repo', REPO, '--auto', '--squash',
            '--match-head-commit', 'head-sha')

    def test_existing_auto_merge_is_idempotent(self):
        self.reconcile({**self.pr, 'auto_merge': {'merge_method': 'squash'}})
        self.gh.assert_not_called()

    def test_untrusted_draft_and_closed_prs_are_skipped(self):
        variants = [
            {'state': 'closed'}, {'draft': True}, {'user': {'login': 'human'}},
            {'head': {'repo': {'full_name': 'fork/repo'}, 'sha': 'sha'}},
            {'head': {'repo': None, 'sha': 'sha'}},
            {'base': {'repo': {'full_name': 'other/repo'}}},
        ]
        for variant in variants:
            with self.subTest(variant=variant):
                self.reconcile({**self.pr, **variant})
                self.gh.assert_not_called()

    def test_conflict_is_waiting_instead_of_failure(self):
        result = self.reconcile({**self.pr, 'mergeable': False, 'mergeable_state': 'dirty'})
        self.assertIn('conflict', result)
        self.gh.assert_not_called()

    def test_unknown_state_has_bounded_retries(self):
        unknown = {**self.pr, 'mergeable': None, 'mergeable_state': 'unknown'}
        with patch.object(self.scope['time'], 'sleep') as sleep:
            result = self.reconcile(*[unknown] * 4)
        self.assertEqual(sleep.call_count, 3)
        self.assertIn('calculation', result)
        self.gh.assert_not_called()

    def test_unknown_state_can_become_ready(self):
        unknown = {**self.pr, 'mergeable': None, 'mergeable_state': 'unknown'}
        with patch.object(self.scope['time'], 'sleep'):
            result = self.reconcile(unknown, self.pr, {**self.pr, 'merged': True})
        self.assertEqual(result, 'Merged (squash)')

    def test_head_race_is_deferred(self):
        self.gh.side_effect = RuntimeError('head changed')
        changed = copy.deepcopy(self.pr)
        changed['head']['sha'] = 'new-head'
        self.assertIn('head changed', self.reconcile(self.pr, changed))

    def test_conflict_race_is_deferred(self):
        self.gh.side_effect = RuntimeError('merge failed')
        self.assertIn('conflict', self.reconcile(
            self.pr, {**self.pr, 'mergeable': False, 'mergeable_state': 'dirty'}))

    def test_permission_error_is_not_hidden(self):
        self.gh.side_effect = RuntimeError('permission denied')
        with self.assertRaisesRegex(RuntimeError, 'permission denied'):
            self.reconcile(self.pr, self.pr)

    def test_scan_continues_after_error_and_fails_with_summary(self):
        self.gh.return_value = '[[{"number": 13}], [{"number": 14}]]'
        self.scope['eligible'] = lambda pr: True
        reconcile = Mock(side_effect=[RuntimeError('permission | denied'), 'Merged (squash)'])
        self.scope['reconcile'] = reconcile
        with tempfile.TemporaryDirectory() as directory:
            summary = Path(directory) / 'summary.md'
            with patch.dict(os.environ, GITHUB_STEP_SUMMARY=str(summary)):
                with patch('sys.stdout', new_callable=io.StringIO):
                    with self.assertRaises(SystemExit) as result:
                        self.scope['main']()
            self.assertEqual(result.exception.code, 1)
            content = summary.read_text(encoding='utf-8')
            self.assertIn('permission &#124; denied', content)
            self.assertIn('| #14 | Merged (squash) |', content)
        self.assertEqual(reconcile.call_count, 2)
        self.assertIn('--paginate', self.gh.call_args.args)

    def test_discovery_failure_is_not_reported_as_empty_success(self):
        self.gh.side_effect = RuntimeError('API unavailable')
        with tempfile.TemporaryDirectory() as directory:
            summary = Path(directory) / 'summary.md'
            with patch.dict(os.environ, GITHUB_STEP_SUMMARY=str(summary)):
                with self.assertRaisesRegex(RuntimeError, 'API unavailable'):
                    self.scope['main']()
            self.assertIn('Discovery failed', summary.read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
