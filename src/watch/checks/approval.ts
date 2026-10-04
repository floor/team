import { reported, type TeamCheck } from '../check.ts';

// The owner's seat: a file that was never approved on this machine, or one that differs from the
// file that was. Reported once while the difference holds. The watch never applies the file
// itself — the report tells the owner, and nothing runs the differing file as approved.
export const approval: TeamCheck = {
  name: 'approval',
  run(team, ctx) {
    if (team.approval === null) {
      return reported(ctx.once('approval', 'the file was never approved on this machine', 'owner'));
    }
    if (team.approval?.length) {
      return reported(ctx.once('approval', `the file differs from the approved one: ${team.approval.join('; ')}`, 'owner'));
    }
    return [];
  },
};
