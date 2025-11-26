const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { logOrderToSheet } = require('./bot'); // Import logOrderToSheet om bestellingen naar de sheet te sturen

// Verwerking van de CSV en berekeningen
async function runReconcile(csvPath, client, triggeredBy) {
    const raw = fs.readFileSync(csvPath, 'utf8');
    const rows = parse(raw, { columns: true, skip_empty_lines: true });

    const matched = [];

    // Haal orders op uit de Google Sheet
    const sheetData = await getSheetData(); // Haal de sheetgegevens op
    console.log('Gegevens uit Google Sheets:', sheetData);

    for (const row of rows) {
        const orderId = row['Order Id'];
        const discordName = row['Discord Name']; // Veronderstel dat de Discord naam in de CSV staat
        const totalAmount = row['Total Order Amount'];

        // Vergelijk de order met die in de sheet
        const orderInSheet = sheetData.find(order => order[0] === orderId);
        if (!orderInSheet) continue;

        // Log de bestelling in de sheet
        await logOrderToSheet(orderId, discordName, totalAmount);

        // Bereken betaling (voorbeeld)
        const paymentAmount = calculatePayment(totalAmount);

        // Update de database of verdere verwerking
        db.prepare(`UPDATE orders SET amount_paid=?, status='paid' WHERE order_id=?`)
            .run(paymentAmount, orderId);

        matched.push(orderId);
    }

    console.log('Verwerkte orders:', matched);

    return { matchedOrders: matched };
}

// Functie om betaling te berekenen
function calculatePayment(amount) {
    const paymentPercentage = 0.8; // 80% van het totale bedrag naar de werknemer
    return amount * paymentPercentage;
}

module.exports = { runReconcile };
