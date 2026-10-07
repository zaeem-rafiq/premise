# Case vectors (VE1)

Every vector of `docs/spec/premise-cases.json` through the Trunk engine (`test/cases/run.test.ts`), run with `CASES=all npm run test:cases` at commit `9ae8768`. 58 of 58 pass.

| Case | Name | Rules | Result |
| --- | --- | --- | --- |
| C01 | disjoint-batch | 9.4, LP2, D1, W4, TA7 | pass |
| C02 | same-file-different-entities | 9.4 step 3b, R4, D2, E0, 5.3 | pass |
| C03 | same-entity-twice | E1, OP1, OP6, T8, GA1, 9.4 step 3b, CK1 | pass |
| C04 | hero-shared-rule-lands-first | 6.5, D1, E2, HU1, T8, CK1 | pass |
| C05 | hero-creature-lands-first | 6.5, D2, QR1, HU1, R4, 8.2 context | pass |
| C06 | read-not-referenced-triage | E3, 7.3 TR1, V1, T5, CK8 | pass |
| C07 | triage-thresholds | 7.3 TR1, TR3, E3, HU3, 7.4 | pass |
| C08 | cosmetic-change-holds | 2.4, E0, F2, R4, CK3 | pass |
| C09 | blind-spot-confirm | 6.4, B1, B2, B3, D1, CK7, CK8, T5 | pass |
| C10 | unread-reference-changes-after-write | 6.5, D1, D3, E2, QO0, B1 | pass |
| C11 | search-sweep-gains-match | 2.6, QT1, HU1, D1 | pass |
| C12 | search-gain-not-swept-triage | QT2, 7.3, 2.6 | pass |
| C13 | listing-gain-additive-holds | L3, 9.4 step 3b, 2.5 | pass |
| C14 | listing-gain-during-sweep | L1, HU1, T8 | pass |
| C15 | replace-no-longer-applies | 5.3, OP2, OP6, OP7, OP8 | pass |
| C16 | go-around-limit | 11.1 GL1, T8, T9, GA1, GL3a, CK0 | pass |
| C17 | contradiction-card | GL3, T9c, E1 | pass |
| C18 | held-path | 10.1 PO1, PO2, 10.2, T4, T13, 11.6, 9.3 | pass |
| C19 | causal-undo-reopens-dependents | 11.3, UN1, UN2, UN3, UN5, T18, T19, E2 | pass |
| C20 | restart-before-push-applied | 9.6 LP3, LP6, 9.7 LP7, LP9, LP1 | pass |
| C21 | restart-after-push-applied | 9.7 LP7, LP9, T16 | pass |
| C22 | restart-diverged | 9.7 LP7, LP9, LP10 | pass |
| C23 | duplicate-submit | TA2, CK0, 9.8 | pass |
| C24 | right-of-way | 11.2 RW1, RW2, RW3, RW5, LP2, 14.6 | pass |
| C25 | changed-before-any-edit | X0, HU2, 8.4 | pass |
| C26 | heads-up-first | TA3, HU7, HU8 | pass |
| C27 | whole-file-write-base-changed | W1, W4, F1, OP5, OP6, 7.2 | pass |
| C28 | empty-change-rejected | CK3, T7, D2 | pass |
| C29 | write-after-landing-needs-reread | W1, 3.2 shown, F2, V4 | pass |
| C30 | blind-spot-after-meaning-change | 6.4, B1, B2, D1, QO0 | pass |
| C31 | triage-window-new-reference | V7, 7.3 TR1, TR4, E2, TA3, V2 | pass |
| C32 | retry-resumes-classified | GL3a, GL5, T21, 7.1, CK8, GA1 | pass |
| C33 | edit-after-validated | T22, 9.3, CK0, TA4 | pass |
| C34 | edit-while-held | T22, T13, 10.2, PO2 | pass |
| C35 | policy-change-in-batch | 9.4 step 3c, CK9, PO3, PO5, T4 | pass |
| C36 | hero-sibling-reference-rule-lands-first | 6.3 ModuleRefs, D1, E2m, 6.5, T5 | pass |
| C37 | hero-sibling-reference-edit-lands-first | 2.5 module hash, D2, QR1m, 8.2 context, 6.5 | pass |
| C38 | reader-landed-triage | QR4, 7.3, 6.5 limits, TR1 | pass |
| C39 | go-around-count-under-repeated-repairs | GA1, T10, T10a, HU8, RW1, RW3 | pass |
| C40 | listing-gain-single-file-edit-holds | L3, 7.2 sweeping, 14.4 | pass |
| C41 | listing-gain-before-sweep | L1 late, L3, 3.2 shown, OP7 | pass |
| C42 | search-gain-one-of-many-altered | QT2, QT1, 7.2 sweeping, TR1 | pass |
| C43 | search-second-match-in-same-entity | 2.6, QT0, X0, 2.5 | pass |
| C44 | whole-module-reference-rule-lands-first | 6.2, D1, F3, 7.2 exhaustive | pass |
| C45 | whole-module-reference-creature-lands-first | 6.2 referrers, D2, QR1 | pass |
| C46 | same-new-entity-added-twice | R4a, E1, 9.4 step 3b | pass |
| C47 | confirm-pull-backs-are-counted | T11, GA3, RW1, RW3, E2m, QR1m | pass |
| C48 | right-of-way-holds-an-approved-landing | RW3, RW5, 10.2, 11.6 | pass |
| C49 | land-now-bypasses-right-of-way | RW5, 10.2, GA1, T10a | pass |
| C50 | push-main-applied-notes-not | LP5, LP1, LP9, 9.6 | pass |
| C51 | push-outcomes-by-ref-value | LP5, LP6, LP7 | pass |
| C52 | restart-with-pending-triage | TR6, 7.3, LP7 | pass |
| C53 | undo-plan-changed | UN4, UN5a, 11.3 | pass |
| C54 | second-repair-from-a-race-sibling | GL3, T8, E1 | pass |
| C55 | info-heads-up-does-not-wake-or-close-a-card | HE2, HU5, TR1, TR3, T13, 11.6 | pass |
| C56 | replace-then-write-base-changed | W4, OP5, OP6, F1 | pass |
| C57 | star-reexport-name-now-shadowed | 6.2 resolveExport, D1b, E2, HU2a | pass |
| C58 | chosen-race-candidate-reopened-by-undo | 11.4 RC1, RC2, RC4, RC7, T4, T13, T14, T19, 11.3, UN2, E2 | pass |
