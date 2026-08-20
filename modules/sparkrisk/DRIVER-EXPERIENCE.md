# ✅ DRIVER EXPERIENCE METRICS ADDED!

## 🎯 **What's New**

Added comprehensive driver experience tracking to help identify:
- 🆕 **New drivers** (< 10 sessions) - Higher fraud risk
- 📊 **Learning drivers** (10-50 sessions) - Medium risk
- 👑 **Veteran drivers** (50+ sessions) - Lower risk

---

## 📊 **Where It Shows**

### **1. Queue Table (new "Exp" column)**

Shows driver experience at a glance:

```
┌───┬───────┬──────┬─────────────────┬─────┬────────────┐
│Pri│ Score │ Conf │ Driver          │ Exp │ Date       │
├───┼───────┼──────┼─────────────────┼─────┼────────────┤
│ 1 │  92.3 │ high │ John Smith      │ 🆕 5│ 2026-07-19 │  ← NEW DRIVER!
│ 1 │  87.5 │ high │ Jane Doe        │   42│ 2026-07-20 │
│ 1 │  85.2 │ high │ Bob Johnson     │ 👑127│ 2026-07-18 │  ← VETERAN
└───┴───────┴──────┴─────────────────┴─────┴────────────┘
```

**Badges**:
- 🆕 = New driver (< 10 sessions)
- (none) = Learning (10-49 sessions)
- 👑 = Veteran (50+ sessions)

**Hover** over the Exp column to see:
- Total sessions
- Total orders

---

### **2. Session Detail Panel (new "Driver Experience" section)**

When you click a session, you'll see:

```
╔════════════════════════════════════════════════════╗
║ Driver Experience                                  ║
╠════════════════════════════════════════════════════╣
║                                                    ║
║  🆕 NEW DRIVER                                     ║
║  5 total sessions · 12 total orders · Active 3 days║
║                                                    ║
║  Total Sessions:  5                                ║
║  Total Orders:    12                               ║
║  First Seen:      2026-07-15                       ║
║  Last Seen:       2026-07-18                       ║
╚════════════════════════════════════════════════════╝
```

**Color-coded badges**:
- 🆕 NEW DRIVER (< 10 sessions) → ⚠️ Orange/red background
- 📊 LEARNING (10-49 sessions) → 🟡 Yellow background  
- 👑 VETERAN (50+ sessions) → ✅ Green background

---

## 🎯 **How It Helps**

### **Prioritization**
- **New drivers** with high scores are **extra suspicious** (less experience = harder to spot patterns)
- **Veterans** with high scores may indicate **behavior change** (compare to their own history)

### **Context**
- See if this is driver's 1st session or 1000th
- Understand if slow performance is inexperience or fraud
- Identify drivers who suddenly got slower after months of normal speed

---

## 📊 **Data Sources**

All calculated from **existing session data**:
- **Total Sessions**: Count of all sessions by this driver
- **Total Orders**: Sum of order_count across all sessions
- **First Seen**: Earliest extraction_date for this driver
- **Last Seen**: Most recent extraction_date
- **Days Active**: Calendar days between first and last session

**No new data needed!** All computed at runtime.

---

## 🔍 **Example Use Cases**

### **Case 1: New Driver, High Score**
```
Driver: John Smith
Experience: 🆕 3 sessions, 8 orders, active 2 days
Score: 95
Excess: +45 min

🚨 HIGH PRIORITY
→ Inexperienced + major deviation = investigate first
```

### **Case 2: Veteran, High Score**
```
Driver: Jane Doe
Experience: 👑 187 sessions, 523 orders, active 89 days
Score: 92
Excess: +38 min

🔎 MODERATE PRIORITY
→ Check if recent behavior change (compare to prior sessions)
→ May be legitimate issue (sick, equipment failure)
```

### **Case 3: New Driver, Low Excess**
```
Driver: Bob Lee
Experience: 🆕 2 sessions, 4 orders, active 1 day
Score: 55
Excess: +8 min

✅ LOWER PRIORITY
→ Slight slowness is normal for new drivers
→ Monitor but don't flag yet
```

---

## 🚀 **How to Use**

### **1. Queue View**
1. Open **SparkRisk** → **Queue** tab
2. Look at **Exp** column
3. **🆕 badge** = new driver (prioritize these!)
4. **Number** = total sessions
5. **Hover** for full stats

### **2. Session Detail**
1. Click any session
2. Scroll to **"Driver Experience"** section
3. See full breakdown:
   - Badge (NEW/LEARNING/VETERAN)
   - Total sessions/orders
   - Days active
   - First/last seen dates

---

## 📝 **Files Changed**

### **Backend** (`modules/sparkrisk/service.js`):
- ✅ `getQueue` - Calculates driver totals for all rows
- ✅ `getSession` - Adds `driverStats` to response

### **Frontend** (`modules/sparkrisk/view.js`):
- ✅ `renderQueue` - Displays Exp column with badge
- ✅ `openSessionDetail` - Shows Driver Experience section

### **HTML** (`modules/sparkrisk/view.html`):
- ✅ Added "Exp" column header
- ✅ Updated colspan from 12 to 13

---

## 🎉 **Benefits**

### **Before**:
- ❌ No way to tell if driver is new or veteran
- ❌ Treated all drivers equally
- ❌ Couldn't distinguish inexperience from fraud

### **After**:
- ✅ **Instant visibility** into driver experience
- ✅ **Prioritize new drivers** automatically
- ✅ **Identify behavior changes** in veterans
- ✅ **Better context** for scoring decisions

---

## 🔄 **How to Apply**

### **Already Applied!**

Just **reload the extension**:
1. `chrome://extensions`
2. Find **APAI Suite**
3. Click **reload** button
4. Refresh SparkRisk page

**No re-import needed!** Calculations happen at runtime from existing data.

---

## 📊 **Expected Results**

After reload, you'll see:

### **Queue**:
- New **"Exp"** column between Driver and Date
- Badges: 🆕 for new, 👑 for veterans
- Hover shows full stats

### **Session Detail**:
- New **"Driver Experience"** section
- Color-coded badge
- 4 stats: Total Sessions, Total Orders, First Seen, Last Seen

---

**Reload extension and check it out!** 🚀

**New drivers will stand out immediately in the queue!** 🆕
