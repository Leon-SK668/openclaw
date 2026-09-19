# Inspectable native content-view captures

These two unmodified PNG files were downloaded from the successful Leon fork run **35279333377**, artifact **10522017717**, proof commit `bf19072f232509e808f2887613c51fd42fabe379`.

They are **macOS-rendered panel content views**, not desktop/window screenshots. `populated` and `blank` are request-value controls in the same implementation, not a before/after comparison of two source revisions. Both retain the action controls; only the populated request displays its synthetic Session value.

The production `ExecApprovalPanelView.swift` and `ExecApprovalsPromptPresenter.swift` blob identities were compared with PR head `a49725c176da7f6f4d90a5703d09ac2224b8c630`. The comparison and image SHA-256 hashes are in `manifest.json`. This does not assert whole-tree equivalence of the proof and PR branches.

The images were opened and visually inspected on September 19, 2026. Publishing them here removes the dependency on the expiring Actions download redirect for inspection. It does not turn the original native run into a new execution or complete the separate source-before/source-after window-capture requirement.
