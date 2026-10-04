// The body of every npm script whose slice has not been built yet. It fails, so that nothing reads a
// missing step as a pass.
//
// Usage: node scripts/ops/not-built.ts <command> <slice>

const [command = "this command", slice = "a later slice"] = process.argv.slice(2);
console.error(`${command}: not built yet. It arrives with ${slice} (docs/spec/04-build-plan.md, section 2).`);
process.exitCode = 1;
