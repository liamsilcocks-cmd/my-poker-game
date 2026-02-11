# POKER BETTING LOGIC FIXES

## CRITICAL BUGS FIXED

### 1. **Minimum Raise After Incomplete All-In (THE MAIN BUG)**

**The Problem:**
When someone went all-in with an incomplete raise, the next player's minimum raise was calculated incorrectly.

**Example of the bug:**
- BB = 50, currentBet = 50, lastRaiseAmount = 50
- Player A goes all-in for 4500 (complete raise)
  - lastRaiseAmount = 4500 - 50 = 4450
  - currentBet = 4500
- Player B goes all-in for 100 chips (incomplete, needs 4500 + 4450 = 8950)
  - currentBet = 100 (BUG: updated to incomplete amount)
  - lastRaiseAmount = 4450 (correctly NOT updated)
- Player C sees:
  - minRaise = 100 + 4450 = 4550 ❌ WRONG!
  - Should be: 4500 + 4450 = 8950 ✅

**The Root Cause:**
We were calculating `minRaise = currentBet + lastRaiseAmount`, but after an incomplete raise, `currentBet` gets updated to the incomplete amount while `lastRaiseAmount` stays at the last LEGAL raise. This created an incorrect calculation.

**The Fix:**
Introduced `lastLegalBet` variable that tracks the last LEGAL bet (not including incomplete raises).

```javascript
// Old (buggy):
const minRaiseTotal = currentBet + lastRaiseAmount;

// New (correct):
const minRaiseTotal = lastLegalBet + lastRaiseIncrement;
```

Now:
- `currentBet` = what players must call (includes incomplete raises)
- `lastLegalBet` = last legal bet for calculating minimum raises
- `lastRaiseIncrement` = the size of the last legal raise


### 2. **TDA-Compliant Incomplete Raise Handling**

**Per TDA Rule 43:**
"If a player goes all-in with a raise that is less than the minimum legal raise, the all-in has no effect on subsequent raise amounts. The minimum raise is still the amount of the last legal raise or the big blind if there has been no previous raise."

**Implementation:**
```javascript
if (p.bet >= minRaiseTotal) {
    // COMPLETE RAISE - reopens action
    lastRaiseIncrement = p.bet - currentBet;
    lastLegalBet = p.bet; // Update the legal bet
    currentBet = p.bet;
    // Reopen action for everyone
} else {
    // INCOMPLETE RAISE - does NOT reopen action
    currentBet = p.bet; // Players must call this
    // lastLegalBet and lastRaiseIncrement stay UNCHANGED
}
```


### 3. **Minimum Raise After New Street**

**The Fix:**
When advancing to a new betting round (flop/turn/river):
```javascript
currentBet = 0;
lastLegalBet = 0; // No bets yet in this round
lastRaiseIncrement = BB; // Minimum bet/raise is always BB
```

This ensures:
- Minimum bet = BB (50)
- Minimum raise after a bet of 200 = 200 + 200 = 400


## COMPLETE BETTING LOGIC FLOW

### Preflop:
1. BB posts 50
   - `currentBet = 50`
   - `lastLegalBet = 50`
   - `lastRaiseIncrement = 50`

2. UTG raises to 150
   - `currentBet = 150`
   - `lastLegalBet = 150`
   - `lastRaiseIncrement = 100` (150 - 50)
   - Next min raise = 150 + 100 = 250 ✅

3. MP goes all-in for 175 (incomplete, needs 250)
   - `currentBet = 175` (what to call)
   - `lastLegalBet = 150` (unchanged!)
   - `lastRaiseIncrement = 100` (unchanged!)
   - Next min raise = 150 + 100 = 250 ✅
   - Can CALL 175 or RAISE to 250+

### Postflop:
1. Reset: `currentBet=0, lastLegalBet=0, lastRaiseIncrement=BB`
2. First player bets 200
   - `currentBet = 200`
   - `lastLegalBet = 200`
   - `lastRaiseIncrement = 200` (200 - 0)
   - Next min raise = 200 + 200 = 400 ✅

## TESTING SCENARIOS

### Scenario 1: Normal Raising
- BB=50 → Raise to 150 → minRaise=250 ✅

### Scenario 2: Multiple All-Ins
- BB=50
- P1 all-in 4500 → minRaise=8950
- P2 all-in 100 (incomplete) → minRaise still 8950 ✅
- P3 must call 4500 or raise to 8950+

### Scenario 3: Postflop Betting
- Flop, no bets → minBet=50
- P1 bets 200 → minRaise=400
- P2 raises to 600 → minRaise=1000 (600 + 400) ✅

## VARIABLES EXPLAINED

| Variable | Purpose | When Updated |
|----------|---------|--------------|
| `currentBet` | Amount to call | Every bet/raise (including incomplete) |
| `lastLegalBet` | Last legal bet | Only on complete raises |
| `lastRaiseIncrement` | Size of last legal raise | Only on complete raises |
| `minRaiseTotal` | Minimum next raise | Calculated as `lastLegalBet + lastRaiseIncrement` |

This ensures TDA-compliant betting at all times!
