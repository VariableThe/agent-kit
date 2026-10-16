---
name: Workstation
description: Offload CPU-, RAM-, or GPU-heavy work to the "workstation" PC (RTX 5080 16GB, 60 GiB RAM, Ryzen 9 9950X3D) over Tailscale SSH. Use when a task is a heavy build, a large test suite, GPU training or inference, or a batch job that would strain the current machine.
---

# Workstation

A dedicated high-spec machine on the same Tailnet exists for work that is too
heavy for the current host. Offload to it instead of grinding the local
machine, or the Beeper host (Asus-Zorin), which should stay responsive.

## Specs

| | |
| --- | --- |
| Host | `workstation` (on the Tailnet; SSH alias in `~/.ssh/config`), Linux, CachyOS (Arch-like) |
| CPU | AMD Ryzen 9 9950X3D |
| RAM | 60 GiB |
| GPU | NVIDIA RTX 5080, **16 GB VRAM** (driver 615.x, CUDA 13.4) |
| Disk | ~170 GB free on `/` |
| Present | `python3`, `node`, `git`, `nvidia-smi` |
| Missing | no Docker, no Ollama |

The 16 GB VRAM figure is a hard ceiling: size models and batch sizes for it,
or use CPU.

## Reach it

```sh
tailscale status | grep -w workstation          # online?
ssh workstation -- 'hostname; nproc; free -g | head -2; nvidia-smi -L'
```

- Login: `ssh workstation` (key-based; see `~/.ssh/config`).
- If Tailscale SSH answers with "requires an additional check", open the
  printed `login.tailscale.com` URL once to re-authorise, then retry.
- Always probe reachability before assuming a job can run there.

## Run work

One-off command:

```sh
ssh workstation -- 'cd ~/work/project && <command>'
```

Longer jobs — copy the repo over, then run detached so the SSH session can
drop:

```sh
rsync -az --exclude .git ./ workstation:~/work/project/
ssh workstation -- 'cd ~/work/project && nohup <command> >run.log 2>&1 & echo STARTED $!'
ssh workstation -- 'tail -n 40 ~/work/project/run.log'   # poll sparingly
```

Or start a `tmux` session there and attach later. Bring results back the same
way (`rsync` from `workstation:...`).

## Etiquette and constraints

- **Do not install system packages without asking.** No Docker or Ollama is
  present by design.
- Keep the box available; don't leave runaway jobs or saturate the GPU
  indefinitely.
- Send only the context a job needs; treat the code and data as private.
- Prefer real runs over guesses: check exit codes and read logs rather than
  assuming a remote job succeeded.

## T3 note

T3 Connect connects clients *to* an environment for interaction; it is not a
job scheduler. For offloading compute, use SSH as above. T3 worktrees are
local to the host that owns them.
