const express = require('express');
const pool = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse incoming JSON payloads
app.use(express.json());

// Sample API Endpoint: Fetch data from the database
app.get('/api/data', async (req, res) => {
  try {
    // Example query (Replace 'your_table' with an actual table in your DB)
    const result = await pool.query('SELECT * FROM your_table LIMIT 10'); 
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// Start the Express server
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});