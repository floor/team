import { reported, type TeamCheck } from '../check.ts';

// The owner's seat: a file that was never approved on this machine, or one that differs from the
// file that was. Reported once while the difference holds. The watch never applies the file
// itself — the report tells the owner, and nothing runs the differing file as approved.
// A record that is not an approval in force but says why — legacy, or refused by the
// verification — is the watch's own one line, said once above the pass; the check adds nothing.
export const approval: TeamCheck = {
  name: 'approval',
  run(team, ctx) {
    if (team.approvalReason != null) return [];
    if (team.approval === null) {
      return reported(ctx.once('approval', 'the file was never approved on this machine', 'owner'));
    }
    if (team.approval?.length) {
      return reported(ctx.once('approval', `the file differs from the approved one: ${team.approval.join('; ')}`, 'owner'));
    }
    return [];
  },
};
