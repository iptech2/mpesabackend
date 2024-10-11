const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');
const mysql = require('mysql2');

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors()); // Enable CORS for all routes

// M-Pesa Credentials from the .env file
const consumerKey = process.env.CONSUMER_KEY;
const consumerSecret = process.env.CONSUMER_SECRET;
const shortCode = process.env.SHORTCODE;
const passKey = process.env.PASSKEY;
const callbackUrl = process.env.CALLBACK_URL;

// MySQL database connection
const db = mysql.createConnection({
  host: 'localhost',
  user: 'root', // Update this
  password: '', // Update this
  database: 'mpesa_payments', // Update if necessary
});

// Connect to the database
db.connect((err) => {
  if (err) {
    console.error('Database connection error: ', err.stack);
    return;
  }
  console.log('Connected to MySQL database.');
});

// Function to get OAuth token
const getOAuthToken = async () => {
  const url = 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  const { data } = await axios.get(url, {
    headers: {
      Authorization: `Basic ${auth}`,
    },
  });
  return data.access_token;
};

// Function to initiate STK Push
const lipaNaMpesaOnline = async (req, res) => {
  const token = await getOAuthToken();
  const url = 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest';

  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
  const password = Buffer.from(`${shortCode}${passKey}${timestamp}`).toString('base64');

  // Convert phone number starting with "07" to "2547"
  let phone = req.body.phone;
  if (phone.startsWith('07')) {
    phone = phone.replace(/^07/, '2547');
  }

  const requestData = {
    BusinessShortCode: shortCode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: req.body.amount,
    PartyA: phone, // Phone number initiating the transaction
    PartyB: shortCode,
    PhoneNumber: phone,
    CallBackURL: callbackUrl,
    AccountReference: 'Baphin',
    TransactionDesc: 'Payment for Baphin',
  };

  try {
    const { data } = await axios.post(url, requestData, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    res.status(200).json(data);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// POST endpoint to initiate the M-Pesa payment
app.post('/mpesa', lipaNaMpesaOnline);

// Add a new route to handle M-Pesa callbacks
app.post('/mpesa/callback', (req, res) => {
  const callbackData = req.body; // This is the response from Safaricom
  console.log('Callback Received:', callbackData);

  // Check for valid callback structure
  if (!callbackData.Body || !callbackData.Body.stkCallback) {
    console.error('Invalid callback structure:', callbackData);
    return res.status(400).json({ message: 'Invalid callback structure' });
  }

  if (callbackData.Body.stkCallback.ResultCode === 0) {
    // Transaction was successful
    const transactionDetails = callbackData.Body.stkCallback.CallbackMetadata.Item;

    // Extract important details from the callback response
    const transactionId = transactionDetails.find(item => item.Name === 'MpesaReceiptNumber').Value;
    const amount = transactionDetails.find(item => item.Name === 'Amount').Value;
    const phoneNumber = transactionDetails.find(item => item.Name === 'PhoneNumber').Value;

    console.log(`Transaction successful. Transaction ID: ${transactionId}, Amount: ${amount}, Phone: ${phoneNumber}`);

    // Save transaction details to MySQL database
    const sql = 'INSERT INTO transactions (transaction_id, amount, phone_number) VALUES (?, ?, ?)';
    db.query(sql, [transactionId, amount, phoneNumber], (err, result) => {
      if (err) {
        console.error('Error inserting transaction into database:', err);
        return res.status(500).json({ message: 'Error saving transaction' });
      } else {
        console.log('Transaction saved successfully:', result);
        return res.status(200).json({
          message: 'Transaction was successful and saved to the database',
          transactionId,
          amount,
          phoneNumber,
        });
      }
    });
  } else {
    // Transaction failed
    console.log('Transaction failed:', callbackData.Body.stkCallback.ResultDesc);
    res.status(400).json({
      message: 'Transaction failed',
      reason: callbackData.Body.stkCallback.ResultDesc,
    });
  }
});

// Start the server
app.listen(8000, () => {
  console.log('Server is running on port 8000');
});
