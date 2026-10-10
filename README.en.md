# p3c-guard

**Java that breaks the Alibaba Java Coding Guidelines never reaches disk when an agent writes it.**

A Claude Code mod. Before `Write` or `Edit` touches a `*.java` file, it runs the p3c rules on the file as it would stand after the write. If the write adds a violation, the write is refused and the agent gets the rule, the line and how to fix it.

[中文](README.md)

![Demo: a Java write that breaks the rules is refused, then passes once fixed](docs/demo.gif)

## Install

```
/plugin install p3c-guard --marketplace alexlifexyz/p3c-guard
```

Needs Claude Code 2.1.296 or newer. Older builds ship with mods turned off, so the plugin installs but does nothing (confirmed on 2.1.284; versions in between are untested): upgrade, or start with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude`. Type `/p3c`: an answer means it is on, `Unknown command` means it is not.

Also needs JDK 21 or newer on `PATH`, and `curl`. The rule engine (13 MB, Maven Central, SHA-256 pinned) is downloaded to `~/.cache/p3c-guard/` on the first Java write; writes made while it downloads are not checked.

## How it behaves

- **Only new violations are refused.** A legacy file full of old violations can still be edited.
- **Priorities 1 and 2 are refused by default** (thread pools, thread safety, wrapper equality, collection misuse, naming: 32 rules). Priority 3 (missing `@author`, magic values and the like: 25 rules) is not. Change it with the `blockPriority` option.
- **It fails open.** No Java, a failed download or a crashed engine lets the write through and says so in the status line.
- **Deterministic.** AST rules, no model call, about one second per file.

`/p3c` shows the counts, `/p3c off` pauses it, `/p3c on` resumes it.

Refusal messages are in Chinese, as the rules' own messages are.

## Limits

Only the 57 rules p3c implements in code are checked, not the whole handbook. Only `Write` and `Edit` are guarded; a file changed through the shell is not. Tested on macOS with JDK 23 and Claude Code 2.1.293; Linux is untested and Windows is not supported.

## Credits

The rules come from [loong95/p3c-cmd-jdk21](https://github.com/loong95/p3c-cmd-jdk21) (Apache-2.0), an unofficial port of [alibaba/p3c](https://github.com/alibaba/p3c) to PMD 7 and JDK 21, downloaded at run time and not redistributed here. This project is not affiliated with or endorsed by Alibaba Group.

MIT licensed. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
