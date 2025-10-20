import express from "express";
import morgan from "morgan";
import axios from "axios";
import cheerio from "cheerio";
import rateLimit from "express-rate-limit";
import LRU from "lru-cache";

const app = express();
app.use(morgan("tiny"));

const API_KEY = process.env.API_KEY || "change-me";
const PORT = process.env.PORT || 3000;

// cache results for 24h
const cache = new LRU({ max: 2000, ttl: 1000 * 60 * 60 * 24 });

// polite rate limit
app.use(rateLimit({ windowMs: 60 * 1000, max: 30 }));

// simple API key auth
app.use((req, res, next) => {
  const key = req.header("X-API-Key");
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
});

function normalizeCode(text = "") {
  const t = text.toLowerCase();
  if (t.includes("case was received")) return "CASE_RECEIVED";
  if (t.includes("request for evidence")) return "RFE_ISSUED";
  if (t.includes("we received your response")) return "RFE_RESPONSE_RECEIVED";
  if (t.includes("interview was scheduled")) return "INTERVIEW_SCHEDULED";
  if (t.includes("case was approved")) return "CASE_APPROVED";
  if (t.includes("new card is being produced") || t.includes("document was produced")) return "CARD_PRODUCED";
  if (t.includes("case was denied")) return "CASE_DENIED";
  if (t.includes("case was transferred")) return "CASE_TRANSFERRED";
  if (t.includes("case was reopened")) return "CASE_REOPENED";
  if (t.includes("case was rejected")) return "CASE_REJECTED";
  return "OTHER";
}

async function fetchStatus(receipt) {
  if (!/^[A-Z]{3}\d{10}$/.test(receipt)) throw new Error("Invalid receipt format");

  const cached = cache.get(receipt);
  if (cached) return { ...cached, cached: true };

  const url = "https://egov.uscis.gov/casestatus/mycasestatus.do";
  const form = new URLSearchParams({ appReceiptNum: receipt });

  const resp = await axios.post(url, form, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (StatusBot; +yourdomain)",
      "Origin": "https://egov.uscis.gov",
      "Referer": "https://egov.uscis.gov/casestatus/landing.do"
    },
    timeout: 15000
  });

  const $ = cheerio.load(resp.data);
  const h1 =
    $("#casestatus_container .rows h1").first().text().trim() ||
    $(".appointment-sec h1").first().text().trim() ||
    $("h1").first().text().trim();
  const p =
    $("#casestatus_container .rows p").first().text().trim() ||
    $(".appointment-sec p").first().text().trim() ||
    $("p").first().text().trim();

  const result = {
    receipt_number: receipt,
    status_code: normalizeCode(`${h1} ${p}`),
    status_headline: h1 || "Unknown",
    status_text: p || "",
    status_url: "https://egov.uscis.gov/casestatus/landing.do",
    fetched_at: new Date().toISOString()
  };
  cache.set(receipt, result);
  return result;
}

app.get("/status", async (req, res) => {
  try {
    const receipt = String(req.query.receipt || "").trim().toUpperCase();
    const data = await fetchStatus(receipt);
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: e.message || "Fetch failed" });
  }
});

app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`USCIS status API running on :${PORT}`));
