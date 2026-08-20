# 📊 SPARKRISK QUEUE COLUMN GUIDE

## 🎯 **Complete Field Breakdown**

Using your example row:
```
Pri │ Score │ Conf │ Driver                │ Exp  │ Date       │ Items/Orders │ Duration  │ Excess │ Register │ Peer Pct │ Prior N │ Status
────┼───────┼──────┼───────────────────────┼──────┼────────────┼──────────────┼───────────┼────────┼──────────┼──────────┼─────────┼────────
 1  │  81   │ high │ DANIEL MONTOYA FAJARDO│  20  │ 2026-07-10 │ 60 ×3        │ 198m 42s  │ +137m  │ 0m 5s    │ 100th    │ 4610    │ new
```

---

## 1️⃣ **Pri** (Priority)
**Full Name**: Review Priority  
**Values**: 1, 2, 3  
**Meaning**: 
- `1` = High priority (investigate first)
- `2` = Medium priority
- `3` = Low priority

**Set By**: Reviewer or auto-assigned based on score
- Score 75+ → Priority 1
- Score 60-74 → Priority 2
- Score < 60 → Priority 3

**Your Example**: `1` = High priority

---

## 2️⃣ **Score** (Priority Score)
**Full Name**: Priority Score (0-100 scale)  
**Meaning**: Composite risk score combining:
- 30 pts: Excess time % (vs expected)
- 30 pts: Driver deviation (vs personal baseline)
- 15 pts: Experience penalty (newer = higher)
- 10 pts: Item count (more items = higher)
- 15 pts: Excess magnitude (absolute time)

**Interpretation**:
- **90-100**: 🚨 Critical (investigate immediately)
- **75-89**: ⚠️ High (review within 24h)
- **60-74**: 🟡 Medium (review within week)
- **45-59**: 🔵 Low (monitor)
- **< 45**: ✅ Normal (archive)

**Your Example**: `81` = High risk, investigate soon

---

## 3️⃣ **Conf** (Confidence)
**Full Name**: Confidence Level  
**Values**: `high`, `medium`, `low`  
**Meaning**: How reliable the score is based on:
- Driver history (more sessions = higher confidence)
- Peer cohort size (more comparisons = higher)
- Data quality (complete events = higher)

**Calculation**:
- `high`: Driver has 10+ prior sessions + large peer group
- `medium`: Driver has 3-9 prior sessions
- `low`: Driver has < 3 prior sessions (new driver)

**Your Example**: `high` = Score is reliable (plenty of data)

---

## 4️⃣ **Driver**
**Full Name**: Driver Name  
**Meaning**: Spark driver's full name (pseudonymized in some views)

**Your Example**: `DANIEL MONTOYA FAJARDO`

---

## 5️⃣ **Exp** (Experience)
**Full Name**: Driver Experience (Total Sessions)  
**Meaning**: How many total sessions this driver has completed (ever)

**Badges**:
- 🆕 = New driver (< 10 sessions)
- (none) = Learning (10-49 sessions)
- 👑 = Veteran (50+ sessions)

**Hover**: Shows total sessions + total orders

**Your Example**: `20` = Learning driver (20 sessions total)
- Not brand new, but still gaining experience
- More prone to mistakes/slowness
- Medium fraud risk (not as high as new, not as low as veteran)

---

## 6️⃣ **Date**
**Full Name**: Extraction Date  
**Format**: YYYY-MM-DD  
**Meaning**: The date this session was extracted from WISMO

**Note**: This is usually 1-2 days after the actual session occurred (WISMO data lag)

**Your Example**: `2026-07-10` = Session occurred on/around July 10, 2026

---

## 7️⃣ **Items / Orders**
**Full Name**: Combined Items × Order Count  
**Format**: `{items} ×{orders}`  
**Meaning**: 
- **Items**: Total item quantity across all orders in this session
- **Orders**: Number of separate orders in this session (batch)

**Calculation**: Sum of `total_order_qty` from all orders

**Your Example**: `60 ×3` = 60 items across 3 orders
- Average: 20 items per order
- Batch delivery (3 orders in one trip)
- High item count = more opportunity for fraud

---

## 8️⃣ **Duration** (Session Duration)
**Full Name**: Total Session Duration  
**Format**: `{minutes}m {seconds}s`  
**Meaning**: Time from PICK_STARTED to PICKED (last item picked)

**Includes**:
- Shopping time
- Finding items
- Moving between aisles
- Any delays/loitering

**Does NOT include**:
- Register/checkout time (separate column)
- Drive time to customer
- Delivery time

**Your Example**: `198m 42s` = 3 hours 18 minutes 42 seconds
- 🚨 VERY LONG for 60 items!
- Expected: ~60 min for 60 items
- Actual: 199 min = 3.3x longer than expected

---

## 9️⃣ **Excess** (Excess Time)
**Full Name**: Excess Time vs Expected  
**Format**: `+{minutes}m` or `-{minutes}m`  
**Meaning**: How much longer/shorter than expected

**Calculation**:
```
Expected Duration = (items × base_spi) × congestion_factor × peak_factor × weekend_factor × batch_factor
Excess = Actual Duration - Expected Duration
```

**Color Coding**:
- 🔴 Red: +20 min or more (very suspicious)
- 🟡 Yellow: +5 to +20 min (suspicious)
- ⚪ White: -5 to +5 min (normal)
- 🔵 Blue: -20 min or less (very fast)

**Your Example**: `+137m` = 137 minutes (2.3 hours) OVER expected
- 🚨 EXTREME excess
- Expected: ~61 min
- Actual: 198 min
- This is the PRIMARY red flag!

---

## 🔟 **Register** (Register Time)
**Full Name**: Register/Checkout Time  
**Format**: `{minutes}m {seconds}s`  
**Meaning**: Time from PICKED to DISPATCHED

**This is**:
- Time at self-checkout
- Scanning items
- Payment
- Bagging

**Fraud Opportunities**:
- Skipping items during scan
- Using wrong PLU codes
- Hiding items in bags
- Double-bagging

**Your Example**: `0m 5s` = 5 seconds
- 🚨 EXTREMELY FAST for 60 items!
- Should be ~5-10 min for 60 items
- 5 sec = likely data error OR extreme fraud (pre-scanned?)

---

## 1️⃣1️⃣ **Peer Pct** (Peer Percentile)
**Full Name**: Peer Percentile Ranking  
**Format**: `{number}th` (1st to 100th)  
**Meaning**: Where this session ranks among similar sessions

**Peer Group**:
- Same item count bucket (±10 items)
- Same day of week type (weekend/weekday)
- Same time of day (±1 hour)

**Interpretation**:
- `100th` = Slowest of all peers (worst)
- `50th` = Middle of the pack
- `1st` = Fastest of all peers (best)

**Your Example**: `100th` = SLOWEST in peer group
- Every single comparable session was faster
- 🚨 Major red flag

---

## 1️⃣2️⃣ **Prior N** (Driver Prior Count)
**Full Name**: Driver Prior Session Count  
**Meaning**: How many sessions this driver had BEFORE this one

**Uses**:
- Calculate driver baseline (median SPI)
- Determine confidence level
- Detect behavior changes

**Calculation**: Strict lookback (only sessions before this one)

**Your Example**: `4610` = 4,610 prior sessions
- 👑 VETERAN driver!
- Tons of history for comparison
- High confidence in baseline
- 🚨 This makes the +137 min EVEN MORE SUSPICIOUS!
  - Veteran driver suddenly 3x slower than normal?
  - Massive deviation from 4,610-session baseline!

---

## 1️⃣3️⃣ **Status** (Review Status)
**Full Name**: Session Review Status  
**Values**: `new`, `in_review`, `cleared`, `confirmed`  
**Meaning**: Investigation status

**Workflow**:
- `new` = Not yet reviewed
- `in_review` = Investigator assigned, reviewing evidence
- `cleared` = Reviewed, no fraud found
- `confirmed` = Reviewed, fraud confirmed

**Your Example**: `new` = Hasn't been reviewed yet

---

## 🔍 **FULL ANALYSIS OF YOUR EXAMPLE**

```
Driver: DANIEL MONTOYA FAJARDO
Score: 81 (HIGH RISK)
Confidence: high (reliable data)
```

### **Red Flags** 🚨:
1. **+137 min excess** = 2.3 hours over expected (EXTREME)
2. **100th percentile** = Slowest of ALL comparable sessions
3. **5 sec register time** = Impossibly fast (data error or fraud)
4. **Veteran driver (4610 sessions)** = Sudden behavior change is suspicious

### **Mitigating Factors** ✅:
1. **60 items** = Large order (some slowness expected)
2. **3 orders** = Batch delivery (some overhead expected)
3. **20 total sessions** = Wait... this contradicts Prior N!

### **Data Inconsistency** ⚠️:
- **Exp column shows**: 20 total sessions
- **Prior N shows**: 4,610 prior sessions
- **Issue**: These should match! (Prior N should be ~19)

**Likely explanation**: Driver experience (Exp) is counting sessions in the current dataset only (20 days of data), while Prior N is counting all historical sessions from WISMO (4,610 lifetime sessions).

**Fix needed**: Exp column should show lifetime total, not just dataset total.

---

## 🎯 **Investigation Priority**

For this session:
1. ✅ **HIGH PRIORITY** (Pri=1, Score=81)
2. 🔍 **Check register time** (5 sec is impossibly fast - data error?)
3. 📹 **Camera review** for the +137 min excess (where was driver?)
4. 📊 **Compare to driver baseline** (4,610 sessions = solid baseline)
5. 🧮 **Validate item count** (60 items confirmed?)

**Expected Outcome**: Either major fraud OR data quality issue (register time error)

---

## 📋 **Quick Reference Table**

| Column | Full Name | Type | Range | Meaning |
|--------|-----------|------|-------|---------|
| Pri | Priority | Number | 1-3 | Review urgency |
| Score | Priority Score | Number | 0-100 | Composite risk |
| Conf | Confidence | Text | low/med/high | Score reliability |
| Driver | Driver Name | Text | - | Who did the session |
| Exp | Experience | Number | 0-5000+ | Total sessions (lifetime) |
| Date | Extraction Date | Date | YYYY-MM-DD | When extracted |
| Items/Orders | Items × Orders | Text | `N ×M` | Item count × batch size |
| Duration | Session Duration | Time | 0-240m | Pick time |
| Excess | Excess Time | Time | -60m to +180m | Over/under expected |
| Register | Register Time | Time | 0-30m | Checkout time |
| Peer Pct | Peer Percentile | Number | 1-100 | Ranking vs peers |
| Prior N | Prior Sessions | Number | 0-5000+ | Driver history count |
| Status | Review Status | Text | new/in_review/cleared/confirmed | Investigation state |

---

**Want me to investigate that data inconsistency (Exp=20 vs Prior N=4610)?** 🐶
