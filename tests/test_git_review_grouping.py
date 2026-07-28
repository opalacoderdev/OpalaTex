import json
import shutil
import subprocess
import textwrap

import pytest


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_review_groups_labeled_agent_turn_checkpoints():
    script = textwrap.dedent(
        """
        import { groupAgentTurns } from './src/utils/gitReviewGrouping.js';

        const commits = [
          { hash: 'orchestrator-end', message: 'Agent turn end checkpoint' },
          { hash: 'worker-end', message: 'Agent turn end checkpoint: worker:command-line' },
          { hash: 'worker-start', message: 'Agent turn start checkpoint: worker:command-line' },
          { hash: 'orchestrator-start', message: 'Agent turn start checkpoint' },
          { hash: 'previous', message: 'Regular checkpoint' },
        ];

        const grouped = groupAgentTurns(commits).map(item => {
          if (item.type === 'agent_turn') {
            return {
              type: item.type,
              start: item.start.hash,
              end: item.end.hash,
              tools: item.tools.map(tool => tool.hash),
            };
          }
          return { type: item.type, commit: item.commit.hash };
        });

        console.log(JSON.stringify(grouped));
        """
    )

    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd="gui_src",
        check=True,
        capture_output=True,
        text=True,
    )

    assert json.loads(result.stdout) == [
        {
            "type": "agent_turn",
            "start": "orchestrator-start",
            "end": "orchestrator-end",
            "tools": [],
        },
        {
            "type": "agent_turn",
            "start": "worker-start",
            "end": "worker-end",
            "tools": [],
        },
        {"type": "commit", "commit": "previous"},
    ]


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_review_groups_legacy_tool_checkpoints_inside_agent_turn():
    script = textwrap.dedent(
        """
        import { groupAgentTurns } from './src/utils/gitReviewGrouping.js';

        const commits = [
          { hash: 'end', message: 'Agent turn end checkpoint' },
          { hash: 'tool', message: 'Agent tool checkpoint: write_content_pos' },
          { hash: 'start', message: 'Agent turn start checkpoint' },
        ];

        const grouped = groupAgentTurns(commits).map(item => ({
          type: item.type,
          start: item.start?.hash,
          end: item.end?.hash,
          tools: item.tools?.map(tool => tool.hash) || [],
        }));

        console.log(JSON.stringify(grouped));
        """
    )

    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd="gui_src",
        check=True,
        capture_output=True,
        text=True,
    )

    assert json.loads(result.stdout) == [
        {
            "type": "agent_turn",
            "start": "start",
            "end": "end",
            "tools": ["tool"],
        },
    ]


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_review_hides_unpaired_agent_checkpoint_markers():
    script = textwrap.dedent(
        """
        import { groupAgentTurns } from './src/utils/gitReviewGrouping.js';

        const commits = [
          { hash: 'orphan-end', message: 'Agent turn end checkpoint' },
          { hash: 'orphan-start', message: 'Agent turn start checkpoint: worker:command-line' },
          { hash: 'orphan-tool', message: 'Agent tool checkpoint: write_content_pos' },
          { hash: 'regular', message: 'Regular checkpoint' },
        ];

        const grouped = groupAgentTurns(commits).map(item => ({
          type: item.type,
          commit: item.commit?.hash,
        }));

        console.log(JSON.stringify(grouped));
        """
    )

    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd="gui_src",
        check=True,
        capture_output=True,
        text=True,
    )

    assert json.loads(result.stdout) == [
        {"type": "commit", "commit": "regular"},
    ]
