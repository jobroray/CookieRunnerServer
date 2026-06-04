require('dotenv').config();
BigInt.prototype.toJSON = function() {
    return this.toString();
};
const express = require('express');
const cors = require('cors');

const { Client, Environment } = require('square/legacy');
const moment = require('moment-timezone'); // ← ADD THIS LINE
const app = express();
app.use(cors());
app.use(express.json());

const token = process.env.SQUARE_ACCESS_TOKEN;
console.log("=== SQUARE TOKEN DIAGNOSTICS ===");
console.log("1. Token actually exists inside Render?", !!token);
if (token) {
    console.log("2. Token character count:", token.length);
    console.log("3. Starts with EAAA?", token.startsWith("EAAA"));
    console.log("4. Has accidental quotes?", token.includes('"') || token.includes("'"));
    console.log("5. Has accidental spaces?", token.includes(' '));
}
console.log("================================");

const squareClient = new Client({
    bearerAuthCredentials: {
        accessToken: process.env.SQUARE_ACCESS_TOKEN
    },
    environment: process.env.SQUARE_ENVIRONMENT === 'sandbox' ? Environment.Sandbox : Environment.Production,
});

// INVENTORY ENDPOINT
app.get('/api/inventory', async (req, res) => {
    try {
        const { result } = await squareClient.catalogApi.searchCatalogObjects({
            objectTypes: ['ITEM', 'CATEGORY'],
            includeRelatedObjects: true
        });

        const imageMap = {};
        const modifierGroupMap = {};
        const categoryMap = {};

        if (result.objects) {
            result.objects.forEach(obj => {
                if (obj.type === 'CATEGORY' && obj.categoryData) {
                    categoryMap[obj.id] = obj.categoryData.name;
                }
            });
        }
        
        if (result.relatedObjects) {
            result.relatedObjects.forEach(obj => {
                if (obj.type === 'IMAGE' && obj.imageData) {
                    imageMap[obj.id] = obj.imageData.url;
                }
                
                if (obj.type === 'MODIFIER_LIST' && obj.modifierListData) {
    const options = (obj.modifierListData.modifiers || []).map(mod => {
        const modifierData = mod.modifierData;
        
        // 👇 NEW: Check if this modifier allows quantity selection
        // In Square, this is controlled by the "quantity_enabled" field
        const allowsQuantity = modifierData.quantityEnabled === true;
        
        return {
            id: mod.id,
            name: modifierData.name,
            price: modifierData.priceMoney ? Number(modifierData.priceMoney.amount) / 100 : 0,
            allowsQuantity: allowsQuantity  // 👈 NEW
        };
    });

    modifierGroupMap[obj.id] = {
        id: obj.id,
        name: obj.modifierListData.name,
        modifiers: options,
        selectionType: obj.modifierListData.selectionType || 'MULTIPLE'
    };
}
            });
        }
        let inventoryMap = {};
        try {
            const inventoryResult = await squareClient.inventoryApi.batchRetrieveInventoryCounts({
                locationIds: [process.env.SQUARE_LOCATION_ID]
            });
            
            if (inventoryResult.result.counts) {
                inventoryResult.result.counts.forEach(count => {
                    inventoryMap[count.catalogObjectId] = {
                        quantity: Number(count.quantity) || 0,
                        state: count.state // SOLD, IN_STOCK, etc.
                    };
                });
            }
            
            console.log(`📦 Fetched inventory for ${Object.keys(inventoryMap).length} items`);
        } catch (invError) {
            console.warn('⚠️ Could not fetch inventory counts:', invError.message);
            // Continue without inventory data
        }
        
        const formattedItems = result.objects.filter(obj => obj.type === 'ITEM').map(item => {
            const itemData = item.itemData;
            const variation = itemData.variations[0];
            const variationData = variation.itemVariationData;
            
            const imageId = itemData.imageIds ? itemData.imageIds[0] : null;
            const imageUrl = imageId ? imageMap[imageId] : "cupcake"; 
            
            const linkedGroups = (itemData.modifierListInfo || [])
                .map(info => {
                    const baseGroup = modifierGroupMap[info.modifierListId];
                    if (!baseGroup) return null;
                    
                    return {
                        id: baseGroup.id,
                        name: baseGroup.name,
                        modifiers: baseGroup.modifiers,
                        selectionType: (info.selectionType || baseGroup.selectionType) === 'SINGLE' ? 'single' : 'multiple',
                        minSelections: info.minSelectedModifiers !== undefined ? info.minSelectedModifiers : null,
                        maxSelections: info.maxSelectedModifiers !== undefined ? info.maxSelectedModifiers : null
                    };
                })
                .filter(Boolean);

            const isFeaturedCookie = (itemData.categories || []).some(cat => categoryMap[cat.id] === "Featured") || 
                                     (categoryMap[itemData.categoryId] === "Featured");
            const inventory = inventoryMap[variation.id];
            const isStockManaged = variationData.trackInventory === true;
            const stockQuantity = (inventory && inventory.state === 'IN_STOCK') ? inventory.quantity : null;

            return {
                id: item.id,
                name: itemData.name,
                category: (itemData.categoryId || itemData.categories?.[0]?.id) ? (categoryMap[itemData.categoryId || itemData.categories?.[0]?.id] || "Other Cookies") : "Other Cookies",
                subtitle: itemData.description || "Freshly baked",
                price: Number(variationData.priceMoney.amount) / 100, 
                imagePath: imageUrl,
                description: itemData.description || "",
                modifierGroups: linkedGroups.length > 0 ? linkedGroups : null,
                isFeatured: isFeaturedCookie,
                stockQuantity: stockQuantity,
                isStockManaged: isStockManaged
            };
        });
        
        console.log(`✅ Fetched ${formattedItems.length} items from Square`);
        formattedItems.forEach(item => {
            if (item.isStockManaged) {
                console.log(`  📊 ${item.name}: ${item.stockQuantity !== null ? item.stockQuantity + ' in stock' : 'No stock data'}`);
            }
            if (item.modifierGroups) {
                item.modifierGroups.forEach(group => {
                    console.log(`     - ${group.name}: ${group.selectionType} (min: ${group.minSelections}, max: ${group.maxSelections})`);
                });
            }
        });
        
        res.json(formattedItems);

    } catch (error) {
        console.error("Error fetching Square inventory:", error);
        res.status(500).json({ error: "Failed to fetch inventory" });
    }
});

// CUSTOMER ENDPOINT
app.post('/api/customer', async (req, res) => {
    try {
        const { name, phone, email } = req.body;
        
        const searchResult = await squareClient.customersApi.searchCustomers({
            query: {
                filter: {
                    emailAddress: {
                        exact: email
                    }
                }
            }
        });
        
        if (searchResult.result.customers && searchResult.result.customers.length > 0) {
            const existingCustomer = searchResult.result.customers[0];
            console.log('Found existing customer:', existingCustomer.id);
            return res.json({ 
                customerId: existingCustomer.id,
                isNew: false 
            });
        }
        
        const createResult = await squareClient.customersApi.createCustomer({
            givenName: name.split(' ')[0],
            familyName: name.split(' ').slice(1).join(' ') || '',
            emailAddress: email,
            phoneNumber: phone
        });
        
        console.log('Created new customer:', createResult.result.customer.id);
        res.json({ 
            customerId: createResult.result.customer.id,
            isNew: true 
        });
        
    } catch (error) {
        console.error('Error with customer:', error);
        res.status(500).json({ 
            error: 'Failed to process customer',
            details: error.message 
        });
    }
});

app.get('/api/orders/active', async (req, res) => {
    try {
        const customerId = req.query.customerId;
        
        if (!customerId) {
            return res.status(400).json({ error: 'customerId required' });
        }
        
        const { result } = await squareClient.ordersApi.searchOrders({
            locationIds: [process.env.SQUARE_LOCATION_ID],
            query: {
                filter: {
                    customerFilter: {
                        customerIds: [customerId]
                    },
                    stateFilter: {
                        states: ['OPEN']
                    },
                    dateTimeFilter: {
                        createdAt: {
                            startAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
                        }
                    }
                },
                sort: {
                    sortField: 'CREATED_AT',
                    sortOrder: 'DESC'
                }
            },
            limit: 50
        });

        const orders = (result.orders || [])
            .filter(order => {
                // 1. Check if it has fulfillments at all
                if (!order.fulfillments || order.fulfillments.length === 0) return false;
                
                // 2. Make sure the fulfillment hasn't already been completed/canceled on the POS
                return order.fulfillments.some(f => f.state !== 'COMPLETED' && f.state !== 'CANCELED');
            })
            .map(order => ({
            id: order.id,
            locationId: order.locationId,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
            state: order.state,
            totalMoney: {
                amount: Number(order.totalMoney.amount), // ← Convert BigInt to Number
                currency: order.totalMoney.currency
            },
            lineItems: order.lineItems?.map(item => ({
                uid: item.uid,
                name: item.name,
                quantity: item.quantity,
                basePriceMoney: item.basePriceMoney ? {
                    amount: Number(item.basePriceMoney.amount), // ← Convert BigInt
                    currency: item.basePriceMoney.currency
                } : null
            })),
            fulfillments: order.fulfillments
        }));

        res.json(orders);
    } catch (error) {
        console.error('Error fetching active orders:', error);
        res.status(500).json({ 
            error: 'Failed to fetch active orders',
            details: error.message 
        });
    }
});

app.get('/api/orders/past', async (req, res) => {
    try {
        const customerId = req.query.customerId;
        
        if (!customerId) {
            return res.status(400).json({ error: 'customerId required' });
        }
        
        const { result } = await squareClient.ordersApi.searchOrders({
            locationIds: [process.env.SQUARE_LOCATION_ID],
            query: {
                filter: {
                    customerFilter: {
                        customerIds: [customerId]
                    },
                    stateFilter: {
                        states: ['COMPLETED', 'CANCELED']
                    },
                    dateTimeFilter: {
                        createdAt: {
                            startAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
                        }
                    }
                },
                sort: {
                    sortField: 'CREATED_AT',
                    sortOrder: 'DESC'
                }
            },
            limit: 50
        });

        const orders = (result.orders || []).map(order => ({
            id: order.id,
            locationId: order.locationId,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
            state: order.state,
            totalMoney: {
                amount: Number(order.totalMoney.amount),
                currency: order.totalMoney.currency
            },
            lineItems: order.lineItems?.map(item => ({
                uid: item.uid,
                name: item.name,
                quantity: item.quantity,
                basePriceMoney: item.basePriceMoney ? {
                    amount: Number(item.basePriceMoney.amount),
                    currency: item.basePriceMoney.currency
                } : null
            })),
            fulfillments: order.fulfillments
        }));

        res.json(orders);
    } catch (error) {
        console.error('Error fetching past orders:', error);
        res.status(500).json({ 
            error: 'Failed to fetch past orders',
            details: error.message 
        });
    }
});
app.get('/api/available-pickup-times', async (req, res) => {
    try {
        const now = new Date();
        const maxDaysAhead = 14;
        const maxOrdersPerSlot = 2;
        const slotIntervalMinutes = 15;
        const minPrepTimeMinutes = 35;
        const locationTimezone = 'America/Chicago';
        
        console.log('⏰ Current time (UTC):', now.toISOString());
        console.log('⏰ Current time (Local):', now.toLocaleString('en-US', { timeZone: locationTimezone }));
        
        // Get location and business hours
        const locationResult = await squareClient.locationsApi.retrieveLocation(
            process.env.SQUARE_LOCATION_ID
        );
        
        const location = locationResult.result.location;
        const businessHours = location.businessHours?.periods || [];
        
        console.log('📍 Location:', location.name);
        console.log('⏱️  Prep time:', minPrepTimeMinutes, 'minutes');
        console.log('🕐 Business hours:', businessHours.length, 'periods');
        
        if (businessHours.length === 0) {
            return res.json({ pickupTimes: [], metadata: { error: 'No business hours' } });
        }
        
        businessHours.forEach(period => {
            console.log(`   ${period.dayOfWeek}: ${period.startLocalTime} - ${period.endLocalTime}`);
        });
        
        // Get existing orders
        const futureDate = new Date(now);
        futureDate.setDate(futureDate.getDate() + maxDaysAhead);
        
        const ordersResult = await squareClient.ordersApi.searchOrders({
            locationIds: [process.env.SQUARE_LOCATION_ID],
            query: {
                filter: {
                    stateFilter: { states: ['OPEN'] },
                    dateTimeFilter: {
                        createdAt: {
                            startAt: now.toISOString(),
                            endAt: futureDate.toISOString()
                        }
                    }
                }
            },
            limit: 500
        });
        
        const ordersBySlot = {};
        if (ordersResult.result.orders) {
            ordersResult.result.orders.forEach(order => {
                if (order.fulfillments?.[0]?.pickupDetails?.pickupAt) {
                    const pickupTime = order.fulfillments[0].pickupDetails.pickupAt;
                    ordersBySlot[pickupTime] = (ordersBySlot[pickupTime] || 0) + 1;
                }
            });
        }
        
        console.log('📦 Existing orders:', Object.keys(ordersBySlot).length, 'slots');
        
        // ✅ NEW LOGIC: Find the next opening time
        const findNextOpeningSlot = (fromTime) => {
            let checkTime = new Date(fromTime);
            const maxChecks = 100; // Prevent infinite loop
            let checks = 0;
            
            while (checks < maxChecks) {
                const formatter = new Intl.DateTimeFormat('en-US', {
                    timeZone: locationTimezone,
                    weekday: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                });
                
                const parts = formatter.formatToParts(checkTime);
                const dayOfWeek = parts.find(p => p.type === 'weekday').value.toUpperCase();
                const hour = parseInt(parts.find(p => p.type === 'hour').value);
                const minute = parseInt(parts.find(p => p.type === 'minute').value);
                
                // Find business hours for this day
                const todayHours = businessHours.find(p => p.dayOfWeek === dayOfWeek);
                
                if (todayHours) {
                    const [startHour, startMin] = todayHours.startLocalTime.split(':').map(Number);
                    const currentMinutes = hour * 60 + minute;
                    const openingMinutes = startHour * 60 + startMin;
                    
                    // If we're before opening time today, return opening time
                    if (currentMinutes < openingMinutes) {
                        // Set to opening time of this day
                        const openingTime = new Date(checkTime);
                        const localDateStr = openingTime.toLocaleDateString('en-US', { 
                            timeZone: locationTimezone,
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit'
                        });
                        const [month, day, year] = localDateStr.split('/');
                        const openingISOStr = `${year}-${month}-${day}T${todayHours.startLocalTime}:00`;
                        
                        // Parse as local time
                        const localOpening = new Date(openingISOStr);
                        return localOpening;
                    } else {
                        // We're during or after opening - return the check time
                        return checkTime;
                    }
                }
                
                // Not open today, try tomorrow
                checkTime = new Date(checkTime.getTime() + 24 * 60 * 60 * 1000);
                checkTime.setHours(0, 0, 0, 0); // Start of next day
                checks++;
            }
            
            return checkTime; // Fallback
        };
        
        // ✅ Determine starting point
        const earliestWithPrep = new Date(now.getTime() + minPrepTimeMinutes * 60 * 1000);
        let startSlot = findNextOpeningSlot(earliestWithPrep);
        
        // Round to next 15-minute interval
        const minutes = startSlot.getMinutes();
        const roundedMinutes = Math.ceil(minutes / slotIntervalMinutes) * slotIntervalMinutes;
        startSlot.setMinutes(roundedMinutes, 0, 0);
        
        console.log('🎯 Earliest pickup with prep:', earliestWithPrep.toISOString());
        console.log('🎯 First available slot:', startSlot.toISOString());
        console.log('🎯 First slot (local):', startSlot.toLocaleString('en-US', { timeZone: locationTimezone }));
        
        // Generate slots
        const availableSlots = [];
        let currentSlot = new Date(startSlot);
        const endDate = new Date(now);
        endDate.setDate(endDate.getDate() + maxDaysAhead);
        
        while (currentSlot < endDate && availableSlots.length < 200) {
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: locationTimezone,
                weekday: 'short',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
            
            const parts = formatter.formatToParts(currentSlot);
            const dayOfWeek = parts.find(p => p.type === 'weekday').value.toUpperCase();
            const hour = parseInt(parts.find(p => p.type === 'hour').value);
            const minute = parseInt(parts.find(p => p.type === 'minute').value);
            
            const isOpen = businessHours.some(period => {
                if (period.dayOfWeek !== dayOfWeek) return false;
                
                const [startHour, startMin] = period.startLocalTime.split(':').map(Number);
                const [endHour, endMin] = period.endLocalTime.split(':').map(Number);
                
                const currentMinutes = hour * 60 + minute;
                const startMinutes = startHour * 60 + startMin;
                const endMinutes = endHour * 60 + endMin;
                
                return currentMinutes >= startMinutes && currentMinutes < endMinutes;
            });
            
            if (isOpen) {
                const slotKey = currentSlot.toISOString();
                const ordersInSlot = ordersBySlot[slotKey] || 0;
                
                if (ordersInSlot < maxOrdersPerSlot) {
                    availableSlots.push({
                        time: slotKey,
                        ordersInSlot: ordersInSlot,
                        spotsLeft: maxOrdersPerSlot - ordersInSlot
                    });
                }
            }
            
            currentSlot = new Date(currentSlot.getTime() + slotIntervalMinutes * 60 * 1000);
        }
        
        console.log(`✅ Generated ${availableSlots.length} slots`);
        
        res.json({ 
            pickupTimes: availableSlots.map(slot => slot.time),
            metadata: {
                totalSlots: availableSlots.length,
                maxOrdersPerSlot: maxOrdersPerSlot,
                intervalMinutes: slotIntervalMinutes,
                prepTimeMinutes: minPrepTimeMinutes
            }
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ 
            error: 'Failed to generate pickup times',
            details: error.message 
        });
    }
});
// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Cookie Runner backend is live on http://localhost:${PORT}`);
});