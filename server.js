/**
 * IQtest254 – Backend API
 * Stack: Node.js + Express + Daraja M-Pesa + Firebase Admin
 * Deploy on: Render.com (free tier)
 *
 * ENVIRONMENT VARIABLES (set in Render dashboard):
 *   MPESA_CONSUMER_KEY        – from Safaricom Daraja portal
 *   MPESA_CONSUMER_SECRET     – from Safaricom Daraja portal
 *   MPESA_SHORTCODE           – your paybill/till number
 *   MPESA_PASSKEY             – from Safaricom Daraja portal
 *   MPESA_CALLBACK_URL        – https://YOUR-RENDER-URL.onrender.com/mpesa/callback
 *   FIREBASE_PROJECT_ID       – from Firebase project settings
 *   FIREBASE_CLIENT_EMAIL     – from Firebase service account JSON
 *   FIREBASE_PRIVATE_KEY      – from Firebase service account JSON (keep quotes)
 *   FRONTEND_URL              – https://your-netlify-site.netlify.app
 */

import express from "express";
import cors from "cors";
import axios from "axios";
import admin from "firebase-admin";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  methods: ["GET", "POST"],
}));

// ─── FIREBASE INIT ────────────────────────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  }),
});
const db = admin.firestore();

// ─── DARAJA HELPERS ───────────────────────────────────────────────────────────
const DARAJA_BASE = "https://api.safaricom.co.ke"; // LIVE
// const DARAJA_BASE = "https://sandbox.safaricom.co.ke"; // SANDBOX – use for testing

async function getDarajaToken() {
  const creds = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString("base64");
  const res = await axios.get(
    `${DARAJA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${creds}` } }
  );
  return res.data.access_token;
}

function getTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

function getPassword(timestamp) {
  const raw = `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`;
  return Buffer.from(raw).toString("base64");
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

/**
 * POST /pay/initiate
 * Body: { phone: "0712345678", sessionId: "abc123" }
 * Creates a session in Firestore and triggers M-Pesa STK push
 */
app.post("/pay/initiate", async (req, res) => {
  try {
    const { phone, sessionId } = req.body;

    if (!phone || !sessionId) {
      return res.status(400).json({ error: "phone and sessionId are required" });
    }

    // Normalise phone → 2547XXXXXXXX
    let normalised = phone.replace(/\s+/g, "").replace(/^0/, "254").replace(/^\+/, "");
    if (normalised.length !== 12 || !normalised.startsWith("254")) {
      return res.status(400).json({ error: "Invalid Kenyan phone number" });
    }

    // Create session in Firestore
    await db.collection("sessions").doc(sessionId).set({
      phone: normalised,
      paid: false,
      amount: 50,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: "pending",
    });

    // Get Daraja token
    const token = await getDarajaToken();
    const timestamp = getTimestamp();
    const password = getPassword(timestamp);

    // Trigger STK push
    const stkRes = await axios.post(
      `${DARAJA_BASE}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: 50,
        PartyA: normalised,
        PartyB: process.env.MPESA_SHORTCODE,
        PhoneNumber: normalised,
        CallBackURL: process.env.MPESA_CALLBACK_URL,
        AccountReference: sessionId,
        TransactionDesc: "IQtest254 Quiz Unlock",
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const checkoutId = stkRes.data.CheckoutRequestID;

    // Save checkoutId to session
    await db.collection("sessions").doc(sessionId).update({
      checkoutRequestId: checkoutId,
    });

    return res.json({
      success: true,
      checkoutRequestId: checkoutId,
      message: "STK push sent. Waiting for user to confirm.",
    });

  } catch (err) {
    console.error("STK Push error:", err?.response?.data || err.message);
    return res.status(500).json({
      error: "Failed to initiate payment",
      detail: err?.response?.data || err.message,
    });
  }
});

/**
 * POST /mpesa/callback
 * Safaricom calls this after user enters PIN
 * Updates Firestore session to paid: true on success
 */
app.post("/mpesa/callback", async (req, res) => {
  try {
    const body = req.body?.Body?.stkCallback;
    if (!body) return res.json({ ResultCode: 0, ResultDesc: "Accepted" });

    const resultCode    = body.ResultCode;
    const checkoutId    = body.CheckoutRequestID;
    const merchantRef   = body.MerchantRequestID;

    console.log(`M-Pesa callback: CheckoutID=${checkoutId} ResultCode=${resultCode}`);

    // Find session by checkoutRequestId
    const snap = await db.collection("sessions")
      .where("checkoutRequestId", "==", checkoutId)
      .limit(1)
      .get();

    if (snap.empty) {
      console.warn("No session found for checkoutId:", checkoutId);
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    const docRef = snap.docs[0].ref;

    if (resultCode === 0) {
      // Payment successful
      const items = body.CallbackMetadata?.Item || [];
      const get = (name) => items.find((i) => i.Name === name)?.Value;

      await docRef.update({
        paid: true,
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        mpesaReceiptNumber: get("MpesaReceiptNumber"),
        transactionDate: String(get("TransactionDate") || ""),
        status: "paid",
      });
      console.log("✅ Payment confirmed:", get("MpesaReceiptNumber"));
    } else {
      // Payment failed or cancelled
      await docRef.update({
        status: "failed",
        failureReason: body.ResultDesc,
      });
      console.log("❌ Payment failed:", body.ResultDesc);
    }

    return res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  } catch (err) {
    console.error("Callback error:", err.message);
    return res.json({ ResultCode: 0, ResultDesc: "Accepted" }); // always 200 to Safaricom
  }
});

/**
 * GET /pay/status/:sessionId
 * Frontend polls this every 3 seconds to check if payment is confirmed
 */
app.get("/pay/status/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const doc = await db.collection("sessions").doc(sessionId).get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Session not found" });
    }

    const data = doc.data();
    return res.json({
      paid: data.paid === true,
      status: data.status,
      receipt: data.mpesaReceiptNumber || null,
    });

  } catch (err) {
    console.error("Status check error:", err.message);
    return res.status(500).json({ error: "Failed to check status" });
  }
});

/**
 * GET /health
 * Health check for Render
 */
app.get("/health", (_, res) => res.json({ status: "ok", service: "IQtest254 API" }));

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 IQtest254 API running on port ${PORT}`));
      
