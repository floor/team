// The wait between passes of a looping command: `true` when the seconds elapse, `false` when a
// stop signal arrives first. Lifted byte for byte from `watch.ts` so another looping command can
// wait and stop the same way.
export function waitOrStop(seconds: number): Promise<boolean> {
  return new Promise((done) => {
    const stop = () => {
      clearTimeout(timer);
      done(false);
    };
    const timer = setTimeout(() => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      done(true);
    }, seconds * 1000);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
