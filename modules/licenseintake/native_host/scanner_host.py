"""
APAISuite Scanner Host — Chrome native messaging host.

Bridges the APAISuite extension to the Canon TS3700 flatbed scanner via WIA.
Actions:
  { "action": "status" }            → { "ok": true, "status": "ready" }
  { "action": "scan", "print": bool } → { "ok", "aamvaText", "croppedPath",
                                          "croppedB64", "scanPath", "barcodeDecoded" }

Install: run install_host.ps1 once. Chrome keeps this process alive; each
"scan" call spawns a fresh PowerShell subprocess so COM state is always clean.
"""
import sys
import json
import struct
import subprocess
import base64
import io
import os
import re
import time
import tempfile
from pathlib import Path

TESSERACT_CMD = r"C:\Users\ses008s.s01458\AppData\Local\Programs\Tesseract-OCR\tesseract.exe"

# ── Native messaging framing ──────────────────────────────────────────────────

def read_msg():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    length = struct.unpack("<I", raw)[0]
    if length == 0:
        return None
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode("utf-8"))

def send_msg(obj):
    encoded = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()

# ── WIA scan via PowerShell subprocess (fresh COM per call) ───────────────────

def wia_scan(out_path: str) -> None:
    """
    Single WIA scan attempt via a fresh PowerShell -File script.
    No retry loop — retries cause the Canon to physically scan N times and
    push the round-trip past the MV3 service worker response window.
    If the device is properly online (USB replugged after power cycle) the
    first attempt succeeds.
    """
    safe_path = out_path.replace("'", "''")

    ps_script = (
        "$ErrorActionPreference = 'Stop'\n"
        "$JPEG = '{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}'\n"
        f"$out  = '{safe_path}'\n"
        "\n"
        "$mgr = New-Object -ComObject WIA.DeviceManager\n"
        "$scanner = $null\n"
        "for ($i = 1; $i -le $mgr.DeviceInfos.Count; $i++) {\n"
        "    $di = $mgr.DeviceInfos.Item($i)\n"
        "    if ($di.Type -eq 1) { $scanner = $di; break }\n"
        "}\n"
        "if (-not $scanner) { throw 'No WIA scanner found. Is the Canon plugged in?' }\n"
        "\n"
        "$dev  = $scanner.Connect()\n"
        "$item = $dev.Items.Item(1)\n"
        "\n"
        "# Warm-up: attempt property sets (fail silently -- triggers internal driver init)\n"
        "foreach ($p in @(6147, 6148, 4116)) {\n"
        "    try { $item.Properties.Item($p).Value = 300 } catch { }\n"
        "}\n"
        "\n"
        "$img = $null\n"
        "try { $img = $item.Transfer($JPEG) } catch { throw ('WIA Transfer error: ' + $_) }\n"
        "\n"
        "if (-not $img) {\n"
        "    throw ('WIA Transfer returned null. ' +\n"
        "           'Ensure you UNPLUGGED the USB after power-cycling the Canon, ' +\n"
        "           'waited for it to fully boot, then replugged the USB before scanning.')\n"
        "}\n"
        "\n"
        "$img.SaveFile($out)\n"
        "Write-Output 'SCAN_OK'\n"
    )

    ps_fd, ps_path = tempfile.mkstemp(suffix=".ps1", prefix="apaisuite_wia_")
    try:
        with os.fdopen(ps_fd, "w", encoding="utf-8-sig", newline="\r\n") as f:
            f.write(ps_script)

        result = subprocess.run(
            # -STA: Single-Threaded Apartment — required by many WIA COM drivers.
            # Without it, Transfer() silently returns null on Canon consumer printers.
            ["powershell", "-STA", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps_path],
            capture_output=True, text=True, timeout=45,
        )
    finally:
        try:
            os.unlink(ps_path)
        except OSError:
            pass

    stdout = result.stdout.strip()
    stderr = result.stderr.strip()
    if "SCAN_OK" not in stdout:
        detail = "\n".join(filter(None, [stdout, stderr]))
        raise RuntimeError(detail or "WIA scan failed")

# ── PDF417 decode ─────────────────────────────────────────────────────────────

def decode_pdf417(image_path: str) -> str | None:
    """Return raw AAMVA text if a PDF417 barcode is found, else None."""
    try:
        import zxingcpp
        from PIL import Image
        img = Image.open(image_path)
        results = zxingcpp.read_barcodes(
            img,
            formats=zxingcpp.BarcodeFormat.PDF417,
            try_rotate=True,
            try_invert=True,
            try_downscale=True,
        )
        if results:
            return results[0].text
    except Exception:
        pass
    return None

# ── OCR via Element LLM ───────────────────────────────────────────────────────

def ocr_license_front(image_path: str) -> tuple[dict | None, str | None]:
    """
    Use Element LLM (vision) to OCR the front of a driver's license.
    Returns (fields_dict, None) on success, (None, error_str) on failure.
    """
    import re

    try:
        import httpx
    except ImportError:
        return None, "httpx not installed (pip install httpx)"

    try:
        from PIL import Image

        img = Image.open(image_path)
        if max(img.size) > 1500:
            img.thumbnail((1500, 1500))

        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=85)
        img_b64 = base64.b64encode(buf.getvalue()).decode("ascii")

        prompt = (
            "Extract all text from this US driver's license image. "
            "Return a JSON object with these exact fields (use null if not visible):\n"
            '{"licenseNumber":"DL number","lastName":"last name","firstName":"first name",'
            '"middleName":"middle name or initial","dob":"YYYY-MM-DD","expirationDate":"YYYY-MM-DD",'
            '"issueDate":"YYYY-MM-DD","address1":"street address","city":"city","state":"2-letter code",'
            '"postalCode":"ZIP","sex":"M or F","heightInches":68,"weightPounds":160,'
            '"eyeColor":"BRN","organDonor":false}\n'
            "Return ONLY the JSON, no explanation."
        )

        resp = httpx.post(
            "https://element.walmart.com/v1/chat/completions",
            headers={"Content-Type": "application/json"},
            json={
                "model": "gpt-4o",
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}},
                        ],
                    }
                ],
                "max_tokens": 500,
                "temperature": 0.1,
            },
            timeout=30,
            verify=False,  # Walmart internal CA
        )

        if resp.status_code != 200:
            return None, f"Element HTTP {resp.status_code}: {resp.text[:200]}"

        content = resp.json()["choices"][0]["message"]["content"]
        # Extract first JSON object, tolerating nested braces (e.g. street addresses).
        start = content.find("{")
        end = content.rfind("}")
        if start == -1 or end == -1 or end < start:
            return None, f"No JSON object in Element response: {content[:200]}"
        data = json.loads(content[start : end + 1])
        return data, None

    except Exception as exc:
        return None, str(exc)

def build_aamva_from_ocr(ocr_data: dict) -> str | None:
    """
    Build a synthetic AAMVA-format string from OCR data so the existing
    license_parser.js can process it uniformly.

    Two key constraints for the AAMVA byte-walk parser in license_parser.js:
    1. The header must NOT contain any real field tags (e.g. DCS) because
       the parser uses first-occurrence-wins — a stray tag in the header
       would shadow the real field value later.
    2. Adjacent fields must be separated by a non-newline, non-stripped
       character (a space) so that the last char of one field's value
       cannot combine with the first two chars of the next tag to form an
       accidental tag.  Example: DADREED + DBB → REEDDBBB contains DDB
       (card-revision tag), which the parser consumes before reaching DBB.
    """
    if not ocr_data:
        return None

    def fmt_date(d):
        """Convert YYYY-MM-DD to MMDDYYYY for AAMVA format."""
        if not d:
            return None
        try:
            parts = d.split("-")
            if len(parts) == 3:
                return f"{parts[1]}{parts[2]}{parts[0]}"
        except Exception:
            pass
        return None

    fields = []
    # Header only — no field tags here
    fields.append("@\n\nANSI 636055080002DL00410278ZG03290015DL")

    if ocr_data.get("licenseNumber"):
        fields.append(f"DAQ{ocr_data['licenseNumber']}")
    if ocr_data.get("lastName"):
        fields.append(f"DCS{ocr_data['lastName'].upper()}")
    if ocr_data.get("firstName"):
        fields.append(f"DAC{ocr_data['firstName'].upper()}")
    if ocr_data.get("middleName"):
        fields.append(f"DAD{ocr_data['middleName'].upper()}")
    if ocr_data.get("dob"):
        dob = fmt_date(ocr_data["dob"])
        if dob:
            fields.append(f"DBB{dob}")
    if ocr_data.get("expirationDate"):
        exp = fmt_date(ocr_data["expirationDate"])
        if exp:
            fields.append(f"DBA{exp}")
    if ocr_data.get("issueDate"):
        iss = fmt_date(ocr_data["issueDate"])
        if iss:
            fields.append(f"DBD{iss}")
    if ocr_data.get("address1"):
        fields.append(f"DAG{ocr_data['address1'].upper()}")
    if ocr_data.get("city"):
        fields.append(f"DAI{ocr_data['city'].upper()}")
    if ocr_data.get("state"):
        fields.append(f"DAJ{ocr_data['state'].upper()}")
    if ocr_data.get("postalCode"):
        fields.append(f"DAK{ocr_data['postalCode']}")
    if ocr_data.get("sex"):
        sex_code = "1" if ocr_data["sex"].upper() == "M" else "2" if ocr_data["sex"].upper() == "F" else "9"
        fields.append(f"DBC{sex_code}")
    if ocr_data.get("heightInches"):
        fields.append(f"DAU{int(ocr_data['heightInches']):03d} in")
    if ocr_data.get("weightPounds"):
        fields.append(f"DAW{int(ocr_data['weightPounds']):03d} lb")
    if ocr_data.get("eyeColor"):
        fields.append(f"DAY{ocr_data['eyeColor'].upper()}")

    # Use "\n " (newline + space) as separator so that after the parser
    # strips newlines, a space remains between adjacent field values.
    # This prevents the last char of one value combining with the first
    # two chars of the next tag to form an accidental AAMVA tag.
    return "\n ".join(fields)

# ── OCR via Tesseract (local fallback) ────────────────────────────────────────

_STATE_CODES = (
    "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS"
    "|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY"
)

def _parse_dl_front_text(raw: str) -> dict | None:
    """Parse raw Tesseract output from a DL front into the same field dict that
    the Element LLM path returns.  Best-effort: returns whatever fields are
    found, or None if nothing at all matched."""
    text = raw.upper()

    data = {}

    def to_iso(mm, dd, yyyy):
        return f"{yyyy}-{mm.zfill(2)}-{dd.zfill(2)}"

    # License number — "DL NO.A1234567", "DL A1234567", "DL 1234567"
    m = re.search(r"\bD[LI1][\s\.]*N?O?\.?\s*([A-Z0-9][A-Z0-9\-]{3,15})\b", text)
    if m:
        data["licenseNumber"] = m.group(1).strip()

    # Extract all MM/DD/YYYY dates from the text and assign by year-range.
    # PSM 11 often splits label and date onto separate lines, making proximity
    # matching unreliable.  Year ranges are unambiguous on a DL:
    #   DOB  → oldest date (year ≤ current year - 16)
    #   ISS  → issued recently (typically last 8 years)
    #   EXP  → future date (year > current year)
    all_dates = re.findall(r"\b(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})\b", text)
    parsed_dates = []
    for mm, dd, yyyy in all_dates:
        yr = int(yyyy)
        if 1900 < yr < 2100:
            parsed_dates.append((yr, to_iso(mm, dd, yyyy)))

    import time as _time
    current_year = int(_time.strftime("%Y"))
    dob_candidates  = [(yr, d) for yr, d in parsed_dates if yr <= current_year - 16]
    exp_candidates  = [(yr, d) for yr, d in parsed_dates if yr > current_year]
    iss_candidates  = [(yr, d) for yr, d in parsed_dates
                       if current_year - 10 <= yr <= current_year]

    if dob_candidates:
        data["dob"] = min(dob_candidates, key=lambda x: x[0])[1]
    if exp_candidates:
        data["expirationDate"] = max(exp_candidates, key=lambda x: x[0])[1]
    if iss_candidates:
        data["issueDate"] = max(iss_candidates, key=lambda x: x[0])[1]

    # Sex — sometimes prefixed with field number: "15 SEX M"
    m = re.search(r"\bSEX\s*[:\-]?\s*([MF])\b", text)
    if m:
        data["sex"] = m.group(1)
    else:
        m = re.search(r"\b(MALE|FEMALE)\b", text)
        if m:
            data["sex"] = "M" if m.group(1) == "MALE" else "F"

    # Height — "HGT 5'-08"" / "5-11" / "5 11 IN"
    m = re.search(r"H[GC]T\s*[:\-]?\s*(\d)['\-\s]+(\d{1,2})", text)
    if not m:
        m = re.search(r"(\d)'\s*-?\s*(\d{1,2})\s*\"?", text)
    if m:
        try:
            data["heightInches"] = int(m.group(1)) * 12 + int(m.group(2))
        except ValueError:
            pass

    # Weight — "WGT 180lb" / "i7wet 180lb" (OCR noise on "17 WGT")
    m = re.search(r"W[GC]T\s*[:\-]?\s*(\d{2,3})", text)
    if not m:
        m = re.search(r"(\d{2,3})\s*LB", text)
    if m:
        try:
            data["weightPounds"] = int(m.group(1))
        except ValueError:
            pass

    # Eye color
    m = re.search(r"EYES?\s*[:\-]?\s*(BRN|BLU|GRN|HZL|GRY|BLK|AMB|PNK|MAR|MUL)", text)
    if m:
        data["eyeColor"] = m.group(1)

    # State + ZIP — comma required; [A-Z ]+ (space only, not \s) so it doesn't
    # span newlines and grab address lines above the city line.
    addr_m = re.search(
        rf"([A-Z][A-Z ]+?),\s+({_STATE_CODES})\s*(\d{{5}}(?:-\d{{4}})?)",
        text,
    )
    if addr_m:
        city_raw = addr_m.group(1).strip()
        # Drop leading single-char OCR artifacts (e.g. "I DALTON" → "DALTON")
        city_words = city_raw.split()
        while city_words and len(city_words[0]) <= 2:
            city_words.pop(0)
        data["city"] = " ".join(city_words) if city_words else city_raw
        data["state"] = addr_m.group(2)
        data["postalCode"] = addr_m.group(3)

    # Street address — must start with 2+ digit number (real street numbers ≥ 10;
    # single-digit DL field numbers like "2 BRYSON REED" are excluded this way).
    _desc_kw = re.compile(
        # ORGAN/DONOR without \b so they match even when embedded in OCR-noise
        # strings like "WORGANDONCR" (OCR reading of "♥ ORGAN DONOR")
        r"\b(?:HGT|WGT|RSTR|REST|EYES?|HAIR|HT|WT|ISS|DOB|EXP|SEX|END)\b"
        r"|ORGAN|DONOR|\d+\s*LBS?"
    )
    _city_zip = re.compile(rf"\b(?:{_STATE_CODES})\s+\d{{5}}")
    for line in raw.splitlines():
        stripped = line.strip().upper()
        if not re.match(r"^\d{2,5}\s+[A-Z]", stripped):
            continue
        if len(stripped) < 8 or len(stripped) > 60:
            continue
        # Real street addresses are pure ASCII — reject OCR garbage with em-dashes,
        # curly quotes, or other non-ASCII artifacts
        if re.search(r"[^\x20-\x7E]", stripped):
            continue
        if _desc_kw.search(stripped) or _city_zip.search(stripped):
            continue
        inline_nums = re.findall(r"\b\d+\s+[A-Z]", stripped)
        if len(inline_nums) > 1:
            continue
        data["address1"] = stripped
        break

    # Name — GA DL format: "1 LASTNAME" on one line, "2 FIRSTNAME MIDDLE" on next.
    # Many states use this "field-number WORD(S)" layout.
    # Strategy: find the first digit within the first 15 chars of each line
    # (that's the field number), then grab the first ALLCAPS word run on that line.
    # Require leading word ≥4 chars to exclude short OCR noise like "VER", "NNT".
    skip_re = re.compile(
        r"DRIVER|LICENSE|IDENTIFICATION|CLASS|C.{0,2}ASS|RSTR|NONE|VETERAN|REAL.?ID"
        r"|ORGAN|DONOR|COMMERCIAL|DL\b|DLNO|EXP\b|DOB\b|ISS\b|SEX\b|HGT\b|WGT\b"
        r"|EYES?\b|HAIR\b|CALIFORNIA|TEXAS|FLORIDA|GEORGIA|ILLINOIS"
        r"|PENNSYLVANIA|OHIO|MICHIGAN|NEW JERSEY|NEW YORK|NORTH|SOUTH|WEST"
        r"|COUNTY|DEPARTMENT|MOTOR|VEHICLE|WHITFIELD|END\b|REST\b|RSTR\b"
    )
    name_fields: list[tuple[int | None, str]] = []
    for line in raw.upper().splitlines():
        line_s = line.strip()
        if not line_s:
            continue
        # Field number: first digit sequence within the first 15 chars of the line
        fn_m = re.search(r"(\d+)", line_s[:15])
        field_num = int(fn_m.group(1)) if fn_m else None
        # Leading word must be ≥4 chars to exclude noise fragments like "VER", "NNT"
        m = re.search(r"\b([A-Z]{4,15}(?:\s+[A-Z]{3,15}){0,2})\b", line_s)
        if not m:
            continue
        span = m.group(1)
        if skip_re.search(span):
            continue
        name_fields.append((field_num, span))

    field2 = next((s for n, s in name_fields if n == 2), None)
    field1 = next((s for n, s in name_fields if n in (1, 4) and s != field2), None)

    if field1 and field2:
        data["lastName"] = field1
        parts2 = field2.split()
        data["firstName"] = parts2[0]
        if len(parts2) > 1:
            data["middleName"] = " ".join(parts2[1:])
    elif field2:
        # field1 not found by number — look for a single-word candidate on a
        # low-numbered or unnumbered line (field ≤ 4 = name/date zone).
        # This catches DUCKWORTH whose "1" field-prefix sometimes reads as "2" noise.
        fallback_last = next(
            (s for n, s in name_fields
             if s != field2
             and len(s.split()) == 1
             and (n is None or n <= 4)),
            None,
        )
        if fallback_last:
            data["lastName"] = fallback_last
        parts2 = field2.split()
        data["firstName"] = parts2[0]
        if len(parts2) > 1:
            data["middleName"] = " ".join(parts2[1:])
    elif field1:
        data["lastName"] = field1

    return data if data else None


def ocr_license_front_tesseract(image_path: str) -> tuple[dict | None, str | None]:
    """
    Extract license fields from the front of a DL using local Tesseract OCR.

    Crops to the right 70% of the card (data-field region) before OCR to exclude
    the state banner (Governor photo, state name, left-side art) that disrupts
    Tesseract's layout analysis.  Two passes on that region:
      Pass 1 — green channel: black DL text is dark in the green channel while
               the coloured card background is bright → high contrast for all text
               including names hidden behind artwork.
      Pass 2 — Gaussian-subtract (radius=80): removes colour-gradient backgrounds,
               often cleaner for address/city/zip lines.
    Results are merged; pass 1 wins when both find a field.

    Returns (fields_dict, None) on success, (None, error_str) on failure.
    """
    try:
        import pytesseract
        from PIL import Image, ImageFilter
        import numpy as np
    except ImportError as e:
        return None, f"pytesseract/Pillow/numpy not installed: {e}"

    try:
        pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD

        orig = Image.open(image_path)
        w, h = orig.size

        # Crop to the right 70% — data fields live here; the state banner/photo
        # is on the left ~30% and confuses Tesseract's line detection.
        data = orig.crop((int(w * 0.30), 0, w, h))
        dw, dh = data.size

        scale = max(2, 600 // min(dw, dh)) if min(dw, dh) < 600 else 2

        def run_ocr(img: Image.Image) -> str:
            up = img.resize((img.width * scale, img.height * scale), Image.LANCZOS)
            up = up.filter(ImageFilter.SHARPEN)
            return pytesseract.image_to_string(up, config="--psm 6 --oem 3")

        # Pass 1: green channel
        raw1 = run_ocr(data.getchannel("G"))
        fields = _parse_dl_front_text(raw1) or {}

        # Pass 2: Gaussian-subtract
        bg = data.convert("L").filter(ImageFilter.GaussianBlur(radius=80))
        arr = np.array(data.convert("L"), dtype=float)
        diff = arr - np.array(bg, dtype=float)
        enhanced = np.clip(128 - diff * 1.5, 0, 255).astype(np.uint8)
        raw2 = run_ocr(Image.fromarray(enhanced))
        fields2 = _parse_dl_front_text(raw2) or {}

        # Merge: fill in anything pass 1 missed
        for k, v in fields2.items():
            if k not in fields or not fields[k]:
                fields[k] = v

        # Pass 3: name zone — top 40% of the data region at 3x scale.
        # At 2x on the full card, field-number prefixes and closely spaced name
        # lines can be skipped by Tesseract; 3x on the name area alone resolves them.
        # Always run and always override name fields — targeted crop is more
        # trustworthy for names than the full-card 2x passes.
        name_zone = data.crop((0, int(dh * 0.05), dw, int(dh * 0.42)))
        nw, nh = name_zone.size
        raw3 = pytesseract.image_to_string(
            name_zone.getchannel("G").resize((nw * 3, nh * 3), Image.LANCZOS).filter(ImageFilter.SHARPEN),
            config="--psm 6 --oem 3",
        )
        fields3 = _parse_dl_front_text(raw3) or {}
        # Override names from lower-res passes with the targeted name-zone result
        for key in ("firstName", "lastName", "middleName"):
            if fields3.get(key):
                fields[key] = fields3[key]
        # Fill in any other fields that passes 1/2 missed
        for k, v in fields3.items():
            if k not in ("firstName", "lastName", "middleName"):
                if k not in fields or not fields[k]:
                    fields[k] = v

        if not fields:
            return None, f"Tesseract ran but no DL fields found. Raw: {raw1[:300]!r}"
        return fields, None

    except Exception as exc:
        return None, f"Tesseract error: {exc}"


# ── DL card crop ──────────────────────────────────────────────────────────────

def crop_dl(image_path: str):
    """
    Detect and crop the driver's license card from a full-page flatbed scan.

    Strategy:
    - Use a low threshold (< 180) to find real DL content (text, photo, colors).
    - Mask the outer 70-px border first to eliminate scanner-glass edge artifacts
      (which can be as dark as ~67 on this Canon even on an empty flatbed).
    - If no content is found after masking (blank scan or DL outside the
      detectable area), return the full image so we at least save something.
    """
    from PIL import Image
    import numpy as np

    img = Image.open(image_path).convert("RGB")
    arr = np.asarray(img)
    h, w = arr.shape[:2]

    # --- mask: pixels significantly darker than scanner background ----
    # Scanner glass on this Canon reads ~225-235; DL text/colors are < 180.
    mask = (arr < 180).any(axis=2).copy()

    # Strip the outer border (scanner glass edge artifacts).
    # 30px is enough to clear the dark edge seal on this Canon while
    # keeping the full card content — 70px was eating into the card edges.
    border = 30
    mask[:border, :]    = False
    mask[h-border:, :]  = False
    mask[:, :border]    = False
    mask[:, w-border:]  = False

    # Require ≥ 20 dark pixels per row/column to count as "content".
    # This filters out isolated dust specks on the scanner glass which
    # individually pass the < 180 threshold but expand the bounding box
    # to nearly the full page.
    MIN_DARK_PX = 20
    rows = mask.sum(axis=1) >= MIN_DARK_PX
    cols = mask.sum(axis=0) >= MIN_DARK_PX

    if not rows.any():
        # Nothing found — return full image as fallback.
        return img

    row_idx = np.where(rows)[0]
    col_idx = np.where(cols)[0]
    rmin, rmax = int(row_idx[0]), int(row_idx[-1])
    cmin, cmax = int(col_idx[0]), int(col_idx[-1])

    margin = max(30, int(min(h, w) * 0.01))
    rmin = max(border, rmin - margin)
    rmax = min(h - border, rmax + margin)
    cmin = max(border, cmin - margin)
    cmax = min(w - border, cmax + margin)

    # A DL card is always 3.375" × 2.125" (≈1.59:1 width:height).
    # Cap height to card_width ÷ 1.2 so that scanner-glass shadow streaks
    # below the card don't extend the bounding box deep into blank space.
    card_w = cmax - cmin
    max_card_h = int(card_w / 1.2)
    if (rmax - rmin) > max_card_h:
        rmax = rmin + max_card_h

    return img.crop((cmin, rmin, cmax, rmax))

# ── Print ─────────────────────────────────────────────────────────────────────

def print_file(file_path: str, printer_pattern: str = "Canon TS3700") -> str:
    """
    Print a JPEG to the Canon using System.Drawing.Printing via PowerShell.
    Discovers the printer by partial name match so minor name variations
    (e.g. 'Canon TS3700 series WS') don't silently fail.
    Returns the printer name used, or raises RuntimeError on failure.
    """
    safe_path = file_path.replace("'", "''")
    safe_pattern = printer_pattern.replace("'", "''")
    ps_script = (
        "Add-Type -AssemblyName System.Drawing\n"
        # Discover printer: prefer one matching the pattern; fall back to default.
        f"$found = Get-Printer | Where-Object {{ $_.Name -like '*{safe_pattern}*' }} | Select-Object -First 1\n"
        "$printerName = if ($found) { $found.Name } else { (Get-Printer -Default | Select-Object -First 1).Name }\n"
        "Write-Output \"PRINTER:$printerName\"\n"
        f"$img = [System.Drawing.Image]::FromFile('{safe_path}')\n"
        "$pd  = New-Object System.Drawing.Printing.PrintDocument\n"
        "$pd.PrinterSettings.PrinterName = $printerName\n"
        "$pd.DefaultPageSettings.Landscape = ($img.Width -gt $img.Height)\n"
        "$pd.add_PrintPage({\n"
        "    param($s,$e)\n"
        "    $e.Graphics.DrawImage($img, $e.MarginBounds)\n"
        "})\n"
        "$pd.Print()\n"
        "$img.Dispose()\n"
        "Write-Output 'PRINT_OK'\n"
    )
    result = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps_script],
        capture_output=True, text=True, timeout=30,
    )
    stdout = result.stdout.strip()
    stderr = result.stderr.strip()
    if "PRINT_OK" not in stdout:
        raise RuntimeError(stderr or stdout or "Print command produced no output")
    printer_line = next((l for l in stdout.splitlines() if l.startswith("PRINTER:")), "")
    return printer_line.removeprefix("PRINTER:").strip() or printer_pattern

# ── Handler ───────────────────────────────────────────────────────────────────

def handle(msg: dict) -> dict:
    action = msg.get("action", "scan")

    if action == "status":
        return {"ok": True, "status": "ready", "host": "com.apaisuite.scanner_host"}

    if action != "scan":
        return {"ok": False, "error": f"Unknown action: {action!r}"}

    # --- Scan ---
    tmp_dir = Path(tempfile.mkdtemp(prefix="apaisuite_scan_"))
    scan_path = str(tmp_dir / "scan.jpg")
    desktop = Path(os.path.expanduser("~")) / "Desktop"

    # 1. WIA scan
    try:
        wia_scan(scan_path)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    # 2. Try PDF417 barcode first (barcode reader handles full-page scans fine)
    aamva_text = decode_pdf417(scan_path)
    ocr_data = None
    ocr_source = False
    ocr_error: str | None = None

    # 3. Crop the DL card from the full-page scan — needed for both OCR and saving
    cropped_path: str | None = None
    cropped_b64: str | None = None
    crop_warning: str | None = None
    cropped_img = None
    cropped_tmp: str | None = None
    try:
        cropped_img = crop_dl(scan_path)
        ts = int(time.time())
        cropped_path = str(desktop / f"dl_evidence_{ts}.jpg")
        cropped_img.save(cropped_path, "JPEG", quality=92)
        # Also keep a temp copy for OCR (same file, just a path alias)
        cropped_tmp = cropped_path
        buf = io.BytesIO()
        thumb = cropped_img.copy()
        thumb.thumbnail((800, 600))
        thumb.save(buf, "JPEG", quality=80)
        cropped_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception as exc:
        crop_warning = f"Crop failed: {exc}"

    # 4. If no barcode, run OCR on the cropped card (much cleaner than full scan)
    if not aamva_text:
        ocr_target = cropped_tmp or scan_path  # fall back to full scan if crop failed
        ocr_data, ocr_error = ocr_license_front(ocr_target)
        if not ocr_data:
            element_err = ocr_error
            ocr_data, ocr_error = ocr_license_front_tesseract(ocr_target)
            if ocr_error:
                ocr_error = f"Element: {element_err or 'failed'}; Tesseract: {ocr_error}"
        if ocr_data:
            aamva_text = build_aamva_from_ocr(ocr_data)
            ocr_source = True
            ocr_error = None

    # 5. Print (optional, defaults to True)
    print_ok: bool | None = None
    print_error: str | None = None
    print_printer: str | None = None
    if msg.get("print", True) and cropped_path:
        try:
            print_printer = print_file(cropped_path)
            print_ok = True
        except Exception as exc:
            print_ok = False
            print_error = str(exc)

    return {
        "ok": True,
        "aamvaText": aamva_text,
        "barcodeDecoded": aamva_text is not None and not ocr_source,
        "ocrDecoded": ocr_source,
        "ocrData": ocr_data,
        "ocrError": ocr_error,
        "croppedPath": cropped_path,
        "croppedB64": cropped_b64,
        "scanPath": scan_path,
        "cropWarning": crop_warning,
        "printOk": print_ok,
        "printError": print_error,
        "printPrinter": print_printer,
    }

# ── Main loop ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    while True:
        msg = read_msg()
        if msg is None:
            break
        try:
            response = handle(msg)
        except Exception as exc:
            response = {"ok": False, "error": str(exc)}
        send_msg(response)
