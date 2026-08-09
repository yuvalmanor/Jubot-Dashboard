# Annual Review freezes only what cannot be recomputed

An Annual Review (סיכום שנתי) is the frozen cross-feature record of where a year ended. The
obvious design is to freeze all of it, so past numbers never move. We are not doing that.

A year's מאזן bottom line — הכנסות, הוצאות, חיסכון — is a pure function of the ledger, so
freezing it just creates a second copy that goes stale the moment a typo from that year is
corrected. Those figures are recomputed live instead. What genuinely cannot be recovered
later is the state of the world on the closing date: the USD/ILS rate, share prices, and the
valuations placed on real-estate projects. Those are stored on the Annual Review, because
nothing can reconstruct them afterwards.

## Consequences

Two prints of the same Annual Review taken months apart can disagree on חיסכון if the
ledger was corrected in between. This is intended — the correction is the point — but the
review must display the ledger figures as live, not as of the freeze date, so the difference
is never mistaken for data loss.
