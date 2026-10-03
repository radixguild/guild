# badge-manager build artifacts (deployed binaries — do not rebuild over these)

These four files are the **only surviving copies** of the compiled BadgeManager package
artifacts (`.wasm` code + `.rpd` package definition). They were gitignored in guild-public
(`badge-manager/build/`) and therefore carried by NO git history — they were rescued from
`~/Projects/_safety/guild-public-preflip-2026-08-14/gitignored-local-only.tar.gz` at fold time
(2026-08-14) and committed here deliberately.

| File | sha256 |
|---|---|
| `radix_badge_manager_v3.wasm` | `520b6788d31d07f3c5195a5b16e0e85b7e833424dac265fa38ee74bcdf93b49a` |
| `radix_badge_manager_v3.rpd`  | `268246ac5b7fecba806945110d63b4506e3ce7a7f389564118ea33c9584c6cde` |
| `radix_badge_manager_v4.wasm` | `18157291854e897216a53b0928b8eee4d354593b92c533d9b4cfb0cd4ef6a581` |
| `radix_badge_manager_v4.rpd`  | `a51fa7f3978ec2944319b72c6b16ed7e1f770d77b8440b2a315035c85b0f96d1` |

They correspond to the deployed BadgeManager packages. The live lineage is
package `package_rdx1phm53al5ztrfw8k5wa3qc5pllwfyeqgl4spjcy83ymgw8jhngx7vu3` →
BadgeFactory `component_rdx1cqxdsz6d3zjsjx7shk2fgg8dazmrknygvqsa4943yw0yz4e69taxhg` →
live manager `component_rdx1czexylvvm0q4uhwpjaqmlznj9sd3y2jnmmah6qug9lm9sfm3tyrtva`
(chain-verified 2026-08-14). ⚠️ The v3/v4 labels were never applied consistently across docs —
see [`../README.md`](../README.md) §"Version labels". Which exact artifact pair matches the
deployed package has NOT been re-proven byte-for-byte here; if you need that guarantee, verify
the package hash against the Gateway before relying on a label.

Directory is named `build-artifacts/` (not `build/`) on purpose: `badge-manager/build/` is in
`.gitignore`, and these must stay tracked.
