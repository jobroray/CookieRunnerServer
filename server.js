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

app.get('/', (req, res) => {
    res.send('Cookie Runner Backend is live and running!');
});

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
// Helper 1: The Rolling 15-Minute Checker
function canBookSlot(candidateTime, ordersBySlot, maxOrdersPerWindow = 2) {
    const w1_0 = candidateTime.clone().toISOString();
    const w1_1 = candidateTime.clone().add(5, 'minutes').toISOString();
    const w1_2 = candidateTime.clone().add(10, 'minutes').toISOString();
    const sum1 = (ordersBySlot[w1_0] || 0) + (ordersBySlot[w1_1] || 0) + (ordersBySlot[w1_2] || 0);

    const w2_0 = candidateTime.clone().subtract(5, 'minutes').toISOString();
    const w2_1 = candidateTime.clone().toISOString();
    const w2_2 = candidateTime.clone().add(5, 'minutes').toISOString();
    const sum2 = (ordersBySlot[w2_0] || 0) + (ordersBySlot[w2_1] || 0) + (ordersBySlot[w2_2] || 0);

    const w3_0 = candidateTime.clone().subtract(10, 'minutes').toISOString();
    const w3_1 = candidateTime.clone().subtract(5, 'minutes').toISOString();
    const w3_2 = candidateTime.clone().toISOString();
    const sum3 = (ordersBySlot[w3_0] || 0) + (ordersBySlot[w3_1] || 0) + (ordersBySlot[w3_2] || 0);

    return (sum1 < maxOrdersPerWindow) && (sum2 < maxOrdersPerWindow) && (sum3 < maxOrdersPerWindow);
}

// Helper 2: The Two-Pass Shared Timeline Builder
async function buildSharedTimeline(squareClient, locationId, businessHours, locationTimezone, minPrepTimeMinutes, maxOrdersPerWindow) {
    const futureDate = moment().add(7, 'days').toDate();
    const ordersResult = await squareClient.ordersApi.searchOrders({
        locationIds: [locationId],
        query: {
            filter: {
                stateFilter: { states: ['OPEN', 'DRAFT', 'COMPLETED'] },
                dateTimeFilter: {
                    createdAt: {
                        startAt: moment().subtract(14, 'days').toISOString(),
                        endAt: futureDate.toISOString()
                    }
                }
            }
        },
        limit: 500
    });

    const ordersBySlot = {};
	ordersBySlot._auditLog = [];
    if (!ordersResult.result.orders) return ordersBySlot;

    ordersResult.result.orders.forEach(order => {
        const pickupDetails = order.fulfillments?.[0]?.pickupDetails;
        if (pickupDetails && pickupDetails.scheduleType === 'SCHEDULED' && pickupDetails.pickupAt) {
            const time = moment(pickupDetails.pickupAt).tz(locationTimezone);
            const roundedMinute = Math.floor(time.minute() / 5) * 5;
            time.minute(roundedMinute).second(0).millisecond(0);
            const slotKey = time.utc().toISOString();
            ordersBySlot[slotKey] = (ordersBySlot[slotKey] || 0) + 1;
	ordersBySlot._auditLog.push(`[SCHEDULED] Order ${order.id.substring(0,6)} -> Slot: ${time.format('ddd h:mm A')}`);
        }
    });

    const asapOrders = ordersResult.result.orders
        .filter(o => o.fulfillments?.[0]?.pickupDetails?.scheduleType === 'ASAP')
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    asapOrders.forEach(order => {
        const orderCreatedAt = moment(order.createdAt).tz(locationTimezone);
        const dayOfWeek = orderCreatedAt.format('ddd').toUpperCase();
        const createdMinutes = orderCreatedAt.hour() * 60 + orderCreatedAt.minute();
        
        const todaysHours = businessHours.find(period => period.dayOfWeek === dayOfWeek);
        
        let isOpenWhenOrdered = false;
        let baseEarliestTime = null;

        if (todaysHours) {
            const [startHour, startMin] = todaysHours.startLocalTime.split(':').map(Number);
            const [endHour, endMin] = todaysHours.endLocalTime.split(':').map(Number);
            const startMinutes = startHour * 60 + startMin;
            const endMinutes = endHour * 60 + endMin;

            if (createdMinutes >= startMinutes && createdMinutes < endMinutes) {
                isOpenWhenOrdered = true;
            } else if (createdMinutes < startMinutes) {
                baseEarliestTime = orderCreatedAt.clone().startOf('day').add(startMinutes, 'minutes');
            }
        }

        if (isOpenWhenOrdered) {
            baseEarliestTime = orderCreatedAt.clone();
        } else if (!baseEarliestTime) {
             baseEarliestTime = orderCreatedAt.clone().add(1, 'day').startOf('day').add(9, 'hours');
        }

        let candidateTime = baseEarliestTime.add(minPrepTimeMinutes, 'minutes');
        const roundedMinute = Math.ceil(candidateTime.minute() / 5) * 5;
        candidateTime.minute(roundedMinute).second(0).millisecond(0);

        while (!canBookSlot(candidateTime, ordersBySlot, maxOrdersPerWindow)) {
            candidateTime.add(5, 'minutes');
        }

        const slotKey = candidateTime.utc().toISOString();
        ordersBySlot[slotKey] = (ordersBySlot[slotKey] || 0) + 1;
	ordersBySlot._auditLog.push(`[ASAP] Order ${order.id.substring(0,6)} (Placed: ${orderCreatedAt.format('ddd h:mm A')}) -> Slot: ${candidateTime.format('ddd h:mm A')}`);
    });

    return ordersBySlot;
}
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
    const options = (obj.modifierListData.modifiers || [])
        .filter(mod => {
            // Filter out modifiers that are explicitly marked as absent at this location
            const modifierData = mod.modifierData;
            
            // Check if modifier is present at the current location
            const absentAtLocations = mod.absentAtLocationIds || [];
            const isAbsent = absentAtLocations.includes(process.env.SQUARE_LOCATION_ID);
            
            // Only include modifiers that are NOT absent
            return !isAbsent;
        })
        .map(mod => {
            const modifierData = mod.modifierData;
            
            const allowsQuantity = modifierData.quantityEnabled === true;
            
            return {
                id: mod.id,
                name: modifierData.name,
                price: modifierData.priceMoney ? Number(modifierData.priceMoney.amount) / 100 : 0,
                allowsQuantity: allowsQuantity
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
    console.log('🔍 Fetching inventory for location:', process.env.SQUARE_LOCATION_ID);
    
    const inventoryResult = await squareClient.inventoryApi.batchRetrieveInventoryCounts({
        locationIds: [process.env.SQUARE_LOCATION_ID]
    });
    
    console.log('📦 Raw inventory response:', JSON.stringify(inventoryResult.result, null, 2));
    
    if (inventoryResult.result.counts) {
        console.log(`📦 Total inventory count records: ${inventoryResult.result.counts.length}`);
        
        inventoryResult.result.counts.forEach(count => {
            console.log(`\n🏷️  Catalog Object ID: ${count.catalogObjectId}`);
            console.log(`   Quantity: ${count.quantity}`);
            console.log(`   State: ${count.state}`);
            console.log(`   Location: ${count.locationId}`);
            
            // Store inventory by catalog object ID
            // If multiple records exist for same ID, keep the one with highest quantity
            if (!inventoryMap[count.catalogObjectId]) {
                inventoryMap[count.catalogObjectId] = {
                    quantity: Number(count.quantity) || 0,
                    state: count.state
                };
            } else {
                // If we already have this ID, take the higher quantity
                const newQty = Number(count.quantity) || 0;
                if (newQty > inventoryMap[count.catalogObjectId].quantity) {
                    inventoryMap[count.catalogObjectId] = {
                        quantity: newQty,
                        state: count.state
                    };
                }
            }
        });
        
        console.log('\n📊 Final Inventory Map:');
        Object.keys(inventoryMap).forEach(id => {
            console.log(`   ${id}: ${inventoryMap[id].quantity} (${inventoryMap[id].state})`);
        });
    } else {
        console.log('⚠️  No inventory counts returned from Square');
    }
    
    console.log(`\n✅ Processed inventory for ${Object.keys(inventoryMap).length} items`);
} catch (invError) {
    console.warn('⚠️ Could not fetch inventory counts:', invError.message);
    console.error(invError);
}
        console.log('🔑 Inventory Map Keys:', Object.keys(inventoryMap));
console.log('📋 Full Inventory Map:', JSON.stringify(inventoryMap, null, 2));

const formattedItems = result.objects.filter(obj => obj.type === 'ITEM').map(item => {
    const itemData = item.itemData;
    
    // Map ALL variations for this item
    const variations = (itemData.variations || []).map(variation => {
        const variationData = variation.itemVariationData;
        
        // Get inventory for this specific variation
        let inventory = inventoryMap[variation.id];
        if (!inventory) {
            inventory = inventoryMap[item.id];
        }
        
        const trackInventoryFlag = variationData.trackInventory === true;
        const hasInventoryData = !!inventory;
        const isStockManaged = hasInventoryData || trackInventoryFlag;
        
        let stockQuantity = null;
        if (inventory) {
            stockQuantity = inventory.quantity;
        } else if (isStockManaged) {
            stockQuantity = 0;
        }
        
        return {
            id: variation.id,
            name: variationData.name,
            price: variationData.priceMoney ? Number(variationData.priceMoney.amount) / 100 : 0,
            sku: variationData.sku || null,
            stockQuantity: stockQuantity,
            isStockManaged: isStockManaged
        };
    });
    
    // Use first variation as default for backward compatibility
    const defaultVariation = variations[0] || { price: 0, stockQuantity: null, isStockManaged: false };
    
    const imageId = itemData.imageIds ? itemData.imageIds[0] : null;
    const imageUrl = imageId ? imageMap[imageId] : null; 

console.log(`📸 Item: ${itemData.name}`);
console.log(`   Image ID: ${imageId}`);
console.log(`   Image URL: ${imageUrl}`);
    
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

    return {
        id: item.id,
        name: itemData.name,
        category: (itemData.categoryId || itemData.categories?.[0]?.id) ? (categoryMap[itemData.categoryId || itemData.categories?.[0]?.id] || "Other Cookies") : "Other Cookies",
        subtitle: itemData.description || "Freshly baked",
        price: defaultVariation.price,  // ✅ Use default variation price
        imagePath: imageUrl,
        description: itemData.description || "",
        modifierGroups: linkedGroups.length > 0 ? linkedGroups : null,
        isFeatured: isFeaturedCookie,
        stockQuantity: defaultVariation.stockQuantity,  // ✅ Use default variation stock
        isStockManaged: defaultVariation.isStockManaged,  // ✅ Use default variation stock tracking
        variations: variations  // ✅ NEW: All size/type options
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
// DISCOUNT CODE VALIDATION ENDPOINT
app.post('/api/validate-discount', async (req, res) => {
    try {
        const { discountCode, orderAmount } = req.body;

        if (!discountCode || orderAmount === undefined) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        console.log(`🏷️  Validating discount code: ${discountCode} for order amount: $${orderAmount}`);

        // Search for the discount in Square's catalog
        const { result } = await squareClient.catalogApi.searchCatalogObjects({
            objectTypes: ['DISCOUNT'],
            query: {
                textQuery: {
                    keywords: [discountCode.toUpperCase()]
                }
            }
        });

        // Check if discount was found
        if (!result.objects || result.objects.length === 0) {
            console.log(`❌ Discount code "${discountCode}" not found`);
            return res.status(404).json({ error: 'Discount code not found' });
        }

        const discount = result.objects[0];
        const discountData = discount.discountData;

        console.log(`✅ Found discount: ${discountData.name}, Type: ${discountData.discountType}`);

        // Handle different discount types
        if (discountData.discountType === 'FIXED_AMOUNT') {
            // Fixed amount discount (e.g., $5 off)
            const discountAmountMoney = discountData.amountMoney;
            const discountAmount = Number(discountAmountMoney.amount) / 100; // Convert from cents

            const finalDiscount = Math.min(discountAmount, orderAmount); // Don't exceed order total

            console.log(`💰 Fixed amount discount: $${discountAmount} (applied: $${finalDiscount})`);

            return res.json({
                valid: true,
                discountAmount: finalDiscount,
                discountType: 'FIXED_AMOUNT',
                discountValue: discountAmount
            });
        } else if (discountData.discountType === 'FIXED_PERCENTAGE') {
            // Percentage discount (e.g., 20% off)
            const percentage = parseFloat(discountData.percentage);
            const discountAmount = (orderAmount * percentage) / 100;

            console.log(`📊 Percentage discount: ${percentage}% (amount: $${discountAmount.toFixed(2)})`);

            return res.json({
                valid: true,
                discountAmount: discountAmount,
                discountType: 'PERCENTAGE',
                discountPercentage: percentage
            });
        } else {
            console.log(`⚠️  Unsupported discount type: ${discountData.discountType}`);
            return res.status(400).json({ error: 'Unsupported discount type' });
        }
    } catch (error) {
        console.error('❌ Error validating discount:', error);
        res.status(500).json({ 
            error: 'Failed to validate discount code',
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
                        states: ['OPEN', 'DRAFT', 'COMPLETED']
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
        const locationTimezone = 'America/Chicago';
        const now = moment().tz(locationTimezone);
        const maxDaysAhead = 14;
        const maxOrdersPerWindow = 2;
        const slotIntervalMinutes = 15;
        const minPrepTimeMinutes = 35;
        
        const locationResult = await squareClient.locationsApi.retrieveLocation(process.env.SQUARE_LOCATION_ID);
        const businessHours = locationResult.result.location.businessHours?.periods || [];
        
        if (businessHours.length === 0) {
            return res.json({ pickupTimes: [], metadata: { error: 'No business hours' } });
        }
        
        const ordersBySlot = await buildSharedTimeline(
            squareClient, 
            process.env.SQUARE_LOCATION_ID, 
            businessHours, 
            locationTimezone, 
            minPrepTimeMinutes, 
            maxOrdersPerWindow
        );
        
        let currentSlot = now.clone().add(minPrepTimeMinutes, 'minutes');
        const currentMinute = currentSlot.minute();
        const roundedMinute = Math.ceil(currentMinute / slotIntervalMinutes) * slotIntervalMinutes;
        currentSlot.minute(roundedMinute).second(0).millisecond(0);
        
        const availableSlots = [];
        const endDate = now.clone().add(maxDaysAhead, 'days');
        let iterations = 0;
        const maxIterations = 2000;
        
        while (currentSlot.isBefore(endDate) && availableSlots.length < 200 && iterations < maxIterations) {
            iterations++;
            
            const dayOfWeek = currentSlot.format('ddd').toUpperCase();
            const currentMinutes = currentSlot.hour() * 60 + currentSlot.minute();
            const dayPeriods = businessHours.filter(period => period.dayOfWeek === dayOfWeek);
            
            if (dayPeriods.length > 0) {
                let foundValidSlot = false;
                
                for (const period of dayPeriods) {
                    const [startHour, startMin] = period.startLocalTime.split(':').map(Number);
                    const [endHour, endMin] = period.endLocalTime.split(':').map(Number);
                    const startMinutes = startHour * 60 + startMin;
                    const endMinutes = endHour * 60 + endMin;
                    
                    if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
                        // THE FIX: Ensure we are at least 35 minutes past opening time
                        const minutesSinceOpening = currentMinutes - startMinutes;
                        
                        if (minutesSinceOpening >= minPrepTimeMinutes) {
                            const remainder = currentSlot.minute() % slotIntervalMinutes;
                            
                            if (remainder === 0 && canBookSlot(currentSlot, ordersBySlot, maxOrdersPerWindow)) {
                                availableSlots.push({ time: currentSlot.toISOString() });
                            }
                            foundValidSlot = true;
                            break;
                        }
                    }
                }
                
                currentSlot.add(slotIntervalMinutes, 'minutes');
            } else {
                currentSlot.add(1, 'day').startOf('day');
            }
        }
        
        res.json({ 
            pickupTimes: availableSlots.map(slot => slot.time),
            metadata: {
                totalSlots: availableSlots.length,
                maxOrdersPerWindow: maxOrdersPerWindow,
                intervalMinutes: slotIntervalMinutes,
                prepTimeMinutes: minPrepTimeMinutes
            }
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: 'Failed to generate pickup times', details: error.message });
    }
});

app.get('/api/debug-timeline', async (req, res) => {
    try {
        const locationTimezone = 'America/Chicago';
        const minPrepTimeMinutes = 35;
        const maxOrdersPerWindow = 2;
        
        const locationResult = await squareClient.locationsApi.retrieveLocation(process.env.SQUARE_LOCATION_ID);
        const businessHours = locationResult.result.location.businessHours?.periods || [];
        
        const ordersBySlot = await buildSharedTimeline(
            squareClient, 
            process.env.SQUARE_LOCATION_ID, 
            businessHours, 
            locationTimezone, 
            minPrepTimeMinutes, 
            maxOrdersPerWindow
        );
	const auditLog = ordersBySlot._auditLog || [];
        delete ordersBySlot._auditLog;
        
        const futureDate = moment().add(7, 'days').toDate();
        const ordersResult = await squareClient.ordersApi.searchOrders({
            locationIds: [process.env.SQUARE_LOCATION_ID],
            query: {
                filter: {
                    // 🚨 REMOVED stateFilter completely so we can see DRAFT, COMPLETED, and CANCELED orders
                    dateTimeFilter: {
                        createdAt: {
                            startAt: moment().subtract(7, 'days').toISOString(), // 🚨 Expanded to 7 days
                            endAt: futureDate.toISOString()
                        }
                    }
                }
            },
            limit: 100
        });

        const cleanOrders = (ordersResult.result.orders || []).map(o => ({
            orderId: o.id.substring(0, 8) + '...',
            state: o.state, // 👈 This will tell us if they are DRAFTs
            createdAt: moment(o.createdAt).tz(locationTimezone).format('ddd M/D h:mm A'),
            scheduleType: o.fulfillments?.[0]?.pickupDetails?.scheduleType || 'UNKNOWN',
            rawPickupAt: o.fulfillments?.[0]?.pickupDetails?.pickupAt || 'NONE',
            formattedPickup: o.fulfillments?.[0]?.pickupDetails?.pickupAt 
                ? moment(o.fulfillments[0].pickupDetails.pickupAt).tz(locationTimezone).format('ddd M/D h:mm A') 
                : 'N/A'
        }));

        res.json({
            status: "SUCCESS",
            timelineBlocks: ordersBySlot,
	auditLog: auditLog,
            totalOrdersFound: cleanOrders.length,
            orderData: cleanOrders
        });
        
    } catch (error) {
        console.error('❌ Debug Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ADD THIS DIAGNOSTIC ENDPOINT to your server.js
app.get('/api/debug-orders', async (req, res) => {
    try {
        console.log('🔍 DEBUGGING ALL ORDERS');
        
        const futureDate = moment().add(7, 'days').toDate();
        
        // Get ALL orders (not just OPEN)
        const allOrdersResult = await squareClient.ordersApi.searchOrders({
            locationIds: [process.env.SQUARE_LOCATION_ID],
            query: {
                filter: {
                    dateTimeFilter: {
                        createdAt: {
                            startAt: moment().subtract(1, 'day').toISOString(), // Last 24 hours
                            endAt: futureDate.toISOString()
                        }
                    }
                }
            },
            limit: 100
        });
        
        console.log(`📦 Total orders found: ${allOrdersResult.result.orders?.length || 0}`);
        
        const orderDetails = [];
        
        if (allOrdersResult.result.orders) {
            allOrdersResult.result.orders.forEach((order, idx) => {
                console.log(`\n--- ORDER ${idx + 1} ---`);
                console.log(`ID: ${order.id}`);
                console.log(`State: ${order.state}`);
                console.log(`Created: ${order.createdAt}`);
                console.log(`Fulfillments: ${order.fulfillments?.length || 0}`);
                
                const detail = {
                    id: order.id.substring(0, 12),
                    state: order.state,
                    createdAt: order.createdAt,
                    fulfillments: []
                };
                
                if (order.fulfillments) {
                    order.fulfillments.forEach((f, fIdx) => {
                        console.log(`  Fulfillment ${fIdx + 1}:`);
                        console.log(`    Type: ${f.type}`);
                        console.log(`    State: ${f.state}`);
                        
                        const fDetail = {
                            type: f.type,
                            state: f.state
                        };
                        
                        if (f.pickupDetails) {
                            console.log(`    Pickup Details:`);
                            console.log(`      Schedule Type: ${f.pickupDetails.scheduleType}`);
                            console.log(`      Pickup At: ${f.pickupDetails.pickupAt || 'NOT SET'}`);
                            
                            fDetail.pickupDetails = {
                                scheduleType: f.pickupDetails.scheduleType,
                                pickupAt: f.pickupDetails.pickupAt
                            };
                            
                            if (f.pickupDetails.pickupAt) {
                                const pickupMoment = moment(f.pickupDetails.pickupAt);
                                console.log(`      Pickup At (formatted): ${pickupMoment.format('ddd M/D h:mm A')}`);
                                fDetail.pickupDetails.pickupAtFormatted = pickupMoment.format('ddd M/D h:mm A');
                            }
                        }
                        
                        detail.fulfillments.push(fDetail);
                    });
                }
                
                orderDetails.push(detail);
            });
        }
        
        res.json({
            totalOrders: allOrdersResult.result.orders?.length || 0,
            orders: orderDetails,
            searchCriteria: {
                locationId: process.env.SQUARE_LOCATION_ID,
                startDate: moment().subtract(1, 'day').format('M/D/YYYY h:mm A'),
                endDate: moment().add(7, 'days').format('M/D/YYYY h:mm A')
            }
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});



app.get('/api/calculate-immediate-pickup', async (req, res) => {
    try {
        const locationTimezone = 'America/Chicago';
        const now = moment().tz(locationTimezone);
        const minPrepTimeMinutes = 35;
        const maxOrdersPerWindow = 2;
        const slotInterval = 5;
        
        const locationResult = await squareClient.locationsApi.retrieveLocation(process.env.SQUARE_LOCATION_ID);
        const businessHours = locationResult.result.location.businessHours?.periods || [];
        
        if (businessHours.length === 0) {
            return res.status(400).json({ error: 'Store is currently closed' });
        }
        
        const ordersBySlot = await buildSharedTimeline(
            squareClient, 
            process.env.SQUARE_LOCATION_ID, 
            businessHours, 
            locationTimezone, 
            minPrepTimeMinutes, 
            maxOrdersPerWindow
        );
        
        let candidateTime = now.clone().add(minPrepTimeMinutes, 'minutes');
        const currentMinute = candidateTime.minute();
        const roundedMinute = Math.ceil(currentMinute / slotInterval) * slotInterval;
        candidateTime.minute(roundedMinute).second(0).millisecond(0);
        
        let iterations = 0;
        const maxIterations = 500;
        
        while (iterations < maxIterations) {
            iterations++;
            
            const dayOfWeek = candidateTime.format('ddd').toUpperCase();
            const candidateMinutes = candidateTime.hour() * 60 + candidateTime.minute();
            
            let isWithinHours = false;
            for (const period of businessHours) {
                if (period.dayOfWeek !== dayOfWeek) continue;
                
                const [startHour, startMin] = period.startLocalTime.split(':').map(Number);
                const [endHour, endMin] = period.endLocalTime.split(':').map(Number);
                const startMinutes = startHour * 60 + startMin;
                const endMinutes = endHour * 60 + endMin;
                
                if (candidateMinutes >= startMinutes && candidateMinutes < endMinutes) {
                    // THE FIX: Ensure we are at least 35 minutes past opening time
                    const minutesSinceOpening = candidateMinutes - startMinutes;
                    if (minutesSinceOpening >= minPrepTimeMinutes) {
                        isWithinHours = true;
                        break;
                    }
                }
            }
            
            if (isWithinHours) {
                if (canBookSlot(candidateTime, ordersBySlot, maxOrdersPerWindow)) {
                    console.log(`✅ FOUND ASAP SLOT: ${candidateTime.format('ddd M/D h:mm A')}`);
                    return res.json({
                        readyTime: candidateTime.toISOString(),
                        prepTimeMinutes: minPrepTimeMinutes,
                        slotInterval: slotInterval
                    });
                }
            }
            
            candidateTime.add(slotInterval, 'minutes');
        }
        
        return res.status(400).json({ error: 'No available pickup times' });
        
    } catch (error) {
        console.error('❌ Error:', error);
        return res.status(500).json({ error: 'Failed to calculate pickup time', details: error.message });
    }
});

// CALCULATE DELIVERY TIME AND CHECK AVAILABILITY
app.get('/api/delivery-availability', async (req, res) => {
    try {
        const locationTimezone = 'America/Chicago';
        const now = moment().tz(locationTimezone);
        
        // Configuration (use env vars with fallbacks)
        const deliveryEnabled = process.env.DELIVERY_ENABLED === 'true';
        const deliveryFee = parseFloat(process.env.DELIVERY_FEE) || 5.00;
        const minPrepTimeMinutes = parseInt(process.env.MIN_PREP_TIME_MINUTES) || 35;
        const deliveryMinTime = parseInt(process.env.DELIVERY_MIN_TIME) || 5;
        const deliveryMaxTime = parseInt(process.env.DELIVERY_MAX_TIME) || 15;
        
        console.log('🚗 Checking delivery availability');
        console.log('   Delivery enabled?', deliveryEnabled);
        console.log('   Current time:', now.format('M/D/YYYY, h:mm:ss A'));
        
        if (!deliveryEnabled) {
            console.log('❌ Delivery is currently disabled');
            return res.json({
                available: false,
                reason: 'Delivery is not currently available'
            });
        }
        
        // Get location and business hours
        const locationResult = await squareClient.locationsApi.retrieveLocation(
            process.env.SQUARE_LOCATION_ID
        );
        
        const location = locationResult.result.location;
        const businessHours = location.businessHours?.periods || [];
        
        if (businessHours.length === 0) {
            console.log('❌ Store is currently closed');
            return res.json({
                available: false,
                reason: 'Store is currently closed'
            });
        }
        
        // Check if store is open now
        const dayOfWeek = now.format('ddd').toUpperCase();
        const currentMinutes = now.hour() * 60 + now.minute();
        
        const dayPeriods = businessHours.filter(period => period.dayOfWeek === dayOfWeek);
        let isOpen = false;
        
        for (const period of dayPeriods) {
            const [startHour, startMin] = period.startLocalTime.split(':').map(Number);
            const [endHour, endMin] = period.endLocalTime.split(':').map(Number);
            
            const startMinutes = startHour * 60 + startMin;
            const endMinutes = endHour * 60 + endMin;
            
            if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
                isOpen = true;
                break;
            }
        }
        
        if (!isOpen) {
            console.log('❌ Store is not currently open');
            return res.json({
                available: false,
                reason: 'Store is not currently open for delivery'
            });
        }
        
        // Calculate delivery window
        // Start = now + prep time + min delivery time
        // End = now + prep time + max delivery time
        const totalMinTime = minPrepTimeMinutes + deliveryMinTime;
        const totalMaxTime = minPrepTimeMinutes + deliveryMaxTime;
        
        const deliveryStart = now.clone().add(totalMinTime, 'minutes');
        const deliveryEnd = now.clone().add(totalMaxTime, 'minutes');
        
        console.log('✅ Delivery available');
        console.log('   Prep time:', minPrepTimeMinutes, 'minutes');
        console.log('   Delivery time:', deliveryMinTime, '-', deliveryMaxTime, 'minutes');
        console.log('   Total time:', totalMinTime, '-', totalMaxTime, 'minutes');
        console.log('   Delivery window:', deliveryStart.format('h:mm A'), '-', deliveryEnd.format('h:mm A'));
        
        res.json({
            available: true,
            deliveryFee: deliveryFee,
            estimatedMinutes: {
                min: totalMinTime,
                max: totalMaxTime
            },
            deliveryStart: deliveryStart.toISOString(),
            deliveryEnd: deliveryEnd.toISOString(),
            deliveryFeeFormatted: `$${deliveryFee.toFixed(2)}`
        });
        
    } catch (error) {
        console.error('❌ Error checking delivery availability:', error);
        res.status(500).json({
            available: false,
            reason: 'Failed to check delivery availability',
            details: error.message
        });
    }
});

// TEST: Check what fulfillment options Square provides
app.get('/api/test-square-fulfillment', async (req, res) => {
    try {
        console.log('🔍 Checking Square location for fulfillment settings...');
        
        const locationResult = await squareClient.locationsApi.retrieveLocation(
            process.env.SQUARE_LOCATION_ID
        );
        
        const location = locationResult.result.location;
        
        console.log('📋 Full location object:', JSON.stringify(location, null, 2));
        
        res.json({
            locationId: location.id,
            name: location.name,
            capabilities: location.capabilities,
            status: location.status,
            businessHours: location.businessHours,
            // Look for any fulfillment-related fields
            allFields: Object.keys(location)
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({
            error: 'Failed to check location',
            details: error.message
        });
    }
});

// PAYMENT PROCESSING ENDPOINT
app.post('/api/process-payment', async (req, res) => {
    try {
        const { 
            nonce, 
            amount, 
            customerId, 
            customerEmail,
            customerName,
            customerPhone,
            pickupAt, 
            discountCode, 
            items,
            fulfillmentType,
            deliveryAddress,
            deliveryInstructions
        } = req.body;

        console.log('💳 Processing payment...');
        console.log('   Amount:', amount);
        console.log('   Customer:', customerId);
        console.log('   Fulfillment type:', fulfillmentType || 'pickup');
        console.log('   Pickup:', pickupAt);
        console.log('   Delivery address:', deliveryAddress);
        console.log('   Discount:', discountCode || 'None');
        console.log('   Items:', items?.length || 0);

        if (!nonce || amount === undefined || amount === null || !customerId || !items || items.length === 0) {
            console.log('❌ Missing fields:', { nonce: !!nonce, amount, customerId: !!customerId, itemCount: items?.length });
            return res.status(400).json({ error: 'Missing required payment fields' });
        }

        // Generate unique idempotency keys
        const { randomUUID } = require('crypto');
        const orderIdempotencyKey = randomUUID();
        const paymentIdempotencyKey = randomUUID();

        // Get discount catalog ID if discount code provided
        let discountCatalogId = null;
        if (discountCode) {
            try {
                const discountResult = await squareClient.catalogApi.searchCatalogObjects({
                    objectTypes: ['DISCOUNT'],
                    query: {
                        textQuery: {
                            keywords: [discountCode.toUpperCase()]
                        }
                    }
                });

                if (discountResult.result.objects && discountResult.result.objects.length > 0) {
                    discountCatalogId = discountResult.result.objects[0].id;
                    console.log(`🏷️  Applying discount: ${discountCode} (${discountCatalogId})`);
                }
            } catch (discountError) {
                console.warn('⚠️  Could not apply discount:', discountError.message);
            }
        }

// Build line items from cart
const lineItems = items.map((item, index) => {
    console.log(`   Building line item ${index + 1}: ${item.name} x${item.quantity}`);
    
    // IMPORTANT: Use variationId as the main catalog object (not as a note!)
    // Square's variations include the dough type, and Square will display it properly
    const catalogId = item.variationId || item.catalogObjectId;
    console.log(`   Using catalog ID: ${catalogId}${item.variationId ? ' (variation)' : ' (item)'}`);
    
    const lineItem = {
        catalogObjectId: catalogId,  // ← This points to the specific variation
        quantity: String(item.quantity)
        // DO NOT include basePriceMoney - Square pulls price from catalog
        // DO NOT add variation as a note - Square handles it automatically
    };

    // Add modifiers if present
    if (item.modifiers && item.modifiers.length > 0) {
        console.log(`      ↳ Adding ${item.modifiers.length} modifiers`);
        lineItem.modifiers = item.modifiers.map(mod => ({
            catalogObjectId: mod.id,  // ← Modifier's catalog ID
            quantity: String(mod.quantity || 1)
            // DO NOT include basePriceMoney for modifiers either
        }));
    }

    return lineItem;
});
        console.log(`📦 Creating order with ${lineItems.length} line items...`);

        // Prepare fulfillment based on type
        let fulfillments = undefined;
        
        if (fulfillmentType === 'delivery') {
            console.log('🚗 Creating delivery fulfillment');
            fulfillments = [{
                type: 'DELIVERY',
                state: 'PROPOSED',
                deliveryDetails: {
                    scheduleType: 'ASAP',
                    recipient: {
                        customerId: customerId,
                        displayName: customerName || 'Customer',
                        phoneNumber: customerPhone,
                        address: {
                            addressLine1: deliveryAddress?.street,
                            addressLine2: deliveryAddress?.apt || undefined,
                            locality: deliveryAddress?.city,
                            administrativeDistrictLevel1: deliveryAddress?.state,
                            postalCode: deliveryAddress?.zip
                        }
                    },
                    note: deliveryInstructions || undefined
                }
            }];
        } else if (pickupAt) {
            console.log('📍 Creating pickup fulfillment');
            fulfillments = [{
                type: 'PICKUP',
                state: 'PROPOSED',
                pickupDetails: {
                    scheduleType: 'SCHEDULED',
                    pickupAt: pickupAt,
                    recipient: {
                        customerId: customerId
                    }
                }
            }];
        }

        // Prepare order object
        const orderRequest = {
            idempotencyKey: orderIdempotencyKey,
            order: {
                locationId: process.env.SQUARE_LOCATION_ID,
                customerId: customerId,
                lineItems: lineItems,
                discounts: discountCatalogId ? [{
                    catalogObjectId: discountCatalogId,
                    scope: 'ORDER'
                }] : undefined,
                fulfillments: fulfillments
            }
        };

        console.log('📤 Creating order in Square...');
        const { result: orderResult } = await squareClient.ordersApi.createOrder(orderRequest);
        console.log('✅ Order created in Square!');
        console.log('   Order ID:', orderResult.order.id);
        console.log('   Order total after discount:', Number(orderResult.order.totalMoney.amount) / 100);

        // Check if this is a free order (100% discount)
        const orderTotal = Number(orderResult.order.totalMoney.amount);
        
        if (orderTotal === 0) {
            console.log('🎁 Free order detected - completing order without payment');
            
            try {
                const payOrderResult = await squareClient.ordersApi.payOrder(orderResult.order.id, {
                    idempotencyKey: paymentIdempotencyKey,
                    orderVersion: orderResult.order.version
                });
                
                console.log('✅ Free order marked as paid in Square');
                console.log('   Order state:', payOrderResult.result.order.state);
                
                return res.json({
                    success: true,
                    orderId: payOrderResult.result.order.id,
                    paymentId: null,
                    totalMoney: payOrderResult.result.order.totalMoney,
                    isFreeOrder: true
                });
            } catch (payError) {
                console.error('❌ Failed to mark free order as paid:', payError.message);
                return res.json({
                    success: true,
                    orderId: orderResult.order.id,
                    paymentId: null,
                    totalMoney: orderResult.order.totalMoney,
                    isFreeOrder: true,
                    warning: 'Order created but not marked as complete'
                });
            }
        }

        // For paid orders, create the payment
        const paymentRequest = {
            idempotencyKey: paymentIdempotencyKey,
            sourceId: nonce,
            amountMoney: {
                amount: BigInt(orderTotal),
                currency: 'USD'
            },
            customerId: customerId,
            orderId: orderResult.order.id
        };

        console.log('💰 Creating payment for $' + (orderTotal / 100));
        const { result: paymentResult } = await squareClient.paymentsApi.createPayment(paymentRequest);
        console.log('✅ Payment successful!');
        console.log('   Payment ID:', paymentResult.payment.id);

        res.json({
            success: true,
            orderId: orderResult.order.id,
            paymentId: paymentResult.payment.id,
            totalMoney: orderResult.order.totalMoney,
            isFreeOrder: false
        });

    } catch (error) {
        console.error('❌ Payment processing error:');
        console.error('   Message:', error.message);
        console.error('   Stack:', error.stack);
        
        if (error.errors) {
            console.error('   Square errors:', JSON.stringify(error.errors, null, 2));
        }
        
        res.status(500).json({ 
            error: 'Payment failed',
            details: error.message,
            squareErrors: error.errors || []
        });
    }
});

// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Cookie Runner backend is live on http://localhost:${PORT}`);
});