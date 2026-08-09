import test from 'node:test';
import assert from 'node:assert/strict';

import { moderationCommand } from '../src/moderation-slash.js';
import { executeTool, moderationDeclarations } from '../src/moderation-tools.js';

function findSubcommand(groupName, subcommandName) {
  const json = moderationCommand.toJSON();
  const group = json.options?.find((option) => option.name === groupName);
  return group?.options?.find((option) => option.name === subcommandName);
}

test('moderation slash commands expose warning and channel tools', () => {
  assert.ok(findSubcommand('member', 'warn'), 'warn subcommand should exist');
  assert.ok(findSubcommand('member', 'warnings'), 'warnings subcommand should exist');
  assert.ok(findSubcommand('member', 'clear_warnings'), 'clear_warnings subcommand should exist');
  assert.ok(findSubcommand('channel', 'topic'), 'topic subcommand should exist');
  assert.ok(findSubcommand('channel', 'invite'), 'invite subcommand should exist');
});

test('moderation tools expose channel reading and writing actions', () => {
  const names = moderationDeclarations.map((decl) => decl.name);
  assert.ok(names.includes('read_channel_messages'), 'read_channel_messages tool should exist');
  assert.ok(names.includes('send_channel_message'), 'send_channel_message tool should exist');
});

test('reading a specific member message uses spoken formatting', async () => {
  const sam = {
    id: '222',
    displayName: 'Sam',
    user: { username: 'sam' },
  };

  const channel = {
    id: '333',
    name: 'chat',
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async () =>
        new Map([
          [
            '1',
            {
              author: { id: '222', username: 'sam', globalName: 'Sam' },
              member: sam,
              cleanContent: 'hello there',
              content: 'hello there',
              createdTimestamp: Date.now(),
            },
          ],
        ]),
    },
  };

  const ctx = {
    guild: {
      id: 'guild-1',
      members: {
        cache: new Map([[sam.id, sam]]),
        me: { id: 'bot' },
      },
      channels: {
        cache: new Map([[channel.name, channel]]),
      },
    },
    requester: { id: '111', displayName: 'Mod', user: { tag: 'Mod#0001' } },
    textChannel: channel,
    voiceChannel: null,
    presenceEnabled: false,
    session: null,
    helpers: null,
  };

  const response = await executeTool('read_channel_messages', { channel: 'chat', member: 'Sam', limit: 1 }, ctx);
  assert.equal(response.done, '1. Sam says: hello there');
});
