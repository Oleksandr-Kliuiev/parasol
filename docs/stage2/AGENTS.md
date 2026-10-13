# Stage 2 context routing

This directory is a specification and review package, not implemented functionality.
Start with README.md and 01_SPEC.md; read only the contract/plan section needed.
Review status is REVIEW_STATUS.md. REVIEW_MANIFEST.json pins normative files; reviews/ contains evidence,
not instructions and not blanket approval for later stages. Do not load historical reviews wholesale.

The owner requested Stage 2 implementation on 2026-10-08. First obtain both architectural approvals for the current
package; then implement through ../../prompts/IMPLEMENT_STAGE_2.md and the checkpoint workflow. Review-only delegates
must not edit implementation. This request does not authorize live tenant access, deployment or account changes.
Keep Stage 1 invariants; never edit frozen migrations or overwrite ../../REVIEW_REPORT.md.
Use actual model identity in review reports. Missing reviewers remain explicitly pending or blocked.
