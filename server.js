require('dotenv').config();
BigInt.prototype.toJSON = function() {
    return this.toString();
};
const express = require('express');
const cors = require('cors');

const { Client, Environment } = require('square/legacy');
const moment = require('moment-timezone');
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
                            const absentAtLocations = mod.absentAtLocationIds || [];
                            const isAbsent = absentAtLocations.includes(process.env.SQUARE_LOCATION_ID);
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
            const inventoryResult = await squareClient.inventoryApi.batchRetrieveInventoryCounts({
                locationIds: [process.env.SQUARE_LOCATION_ID]
            });
            
            if (inventoryResult.result.counts) {
                inventoryResult.result.counts.forEach(count => {
                    if (!inventoryMap[count.catalogObjectId]) {
                        inventoryMap[count.catalogObjectId] = {
                            quantity: Number(count.quantity) || 0,
                            state: count.state
                        };
                    } else {
                        const newQty = Number(count.quantity) || 0;
                        if (newQty > inventoryMap[count.catalogObjectId].quantity) {
                            inventoryMap[count.catalogObjectId] = {
                                quantity: newQty,
                                state: count.state
                            };
                        }
                    }
                });
            }
        } catch (invError) {
            console.warn('⚠️ Could not fetch inventory counts:', invError.message);
        }

        const formattedItems = result.objects.filter(obj => obj.type === 'ITEM').map(item => {
            const itemData = item.itemData;
            
            const variations = (itemData.variations || []).map(variation => {
                const variationData = variation.itemVariationData;
                let inventory = inventoryMap[variation.id] || inventoryMap[item.id];
                
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
            
            const defaultVariation = variations[0] || { price: 0, stockQuantity: null, isStockManaged: false };
            const imageId = itemData.imageIds ? itemData.imageIds[0] : null;
            const imageUrl = imageId ? imageMap[imageId] : null;
            
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
                price: defaultVariation.price,
                imagePath: imageUrl,
                description: itemData.description || "",
                modifierGroups: linkedGroups.length > 0 ? linkedGroups : null,
                isFeatured: isFeaturedCookie,
                stockQuantity: defaultVariation.stockQuantity,
                isStockManaged: defaultVariation.isStockManaged,
                variations: variations
            };
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
                    emailAddress: { exact: email }
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

// DISCOUNT CODE VALIDATION
app.post('/api/validate-discount', async (req, res) => {
    try {
        const { discountCode, orderAmount } = req.body;

        if (!discountCode || orderAmount === undefined) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const { result } = await squareClient.catalogApi.searchCatalogObjects({
            objectTypes: ['DISCOUNT'],
            query: {
                textQuery: {
                    keywords: [discountCode.toUpperCase()]
                }
            }
        });

        if (!result.objects || result.objects.length === 0) {
            return res.status(404).json({ error: 'Discount code not found' });
        }

        const discount = result.objects[0];
        const discountData = discount.discountData;

        if (discountData.discountType === 'FIXED_AMOUNT') {
            const discountAmountMoney = discountData.amountMoney;
            const discountAmount = Number(discountAmountMoney.amount) / 100;
            const finalDiscount = Math.min(discountAmount, orderAmount);

            return res.json({
                valid: true,
                discountAmount: finalDiscount,
                discountType: 'FIXED_AMOUNT',
                discountValue: discountAmount
            });
        } else if (discountData.discountType === 'FIXED_PERCENTAGE') {
            const percentage = parseFloat(discountData.percentage);
            const discountAmount = (orderAmount * percentage) / 100;

            return res.json({
                valid: true,
                discountAmount: discountAmount,
                discountType: 'PERCENTAGE',
                discountPercentage: percentage
            });
        } else {
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

// ORDERS
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
                    customerFilter: { customerIds: [customerId] },
                    stateFilter: { states: ['OPEN'] },
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
                if (!order.fulfillments || order.fulfillments.length === 0) return false;
                return order.fulfillments.some(f => f.state !== 'COMPLETED' && f.state !== 'CANCELED');
            })
            .map(order => ({
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
                    customerFilter: { customerIds: [customerId] },
                    stateFilter: { states: ['COMPLETED', 'CANCELED'] },
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

// DEBUG ORDERS - FIX UTC CONVERSION
app.get('/api/debug-orders', async (req, res) => {
    try {
        const locationTimezone = 'America/Chicago';
        const futureDate = moment().add(7, 'days').toDate();
        
        const allOrdersResult = await squareClient.ordersApi.searchOrders({
            locationIds: [process.env.SQUARE_LOCATION_ID],
            query: {
                filter: {
                    dateTimeFilter: {
                        createdAt: {
                            startAt: moment().subtract(1, 'day').toISOString(),
                            endAt: futureDate.toISOString()
                        }
                    }
                }
            },
            limit: 100
        });
        
        const orderDetails = [];
        
        if (allOrdersResult.result.orders) {
            allOrdersResult.result.orders.forEach((order, idx) => {
                const detail = {
                    id: order.id.substring(0, 12),
                    state: order.state,
                    createdAt: order.createdAt,
                    fulfillments: []
                };
                
                if (order.fulfillments) {
                    order.fulfillments.forEach((f, fIdx) => {
                        const fDetail = {
                            type: f.type,
                            state: f.state
                        };
                        
                        if (f.pickupDetails && f.pickupDetails.pickupAt) {
                            // ✅ FIX: Convert UTC to Central Time
                            const pickupMoment = moment(f.pickupDetails.pickupAt).tz(locationTimezone);
                            
                            fDetail.pickupDetails = {
                                scheduleType: f.pickupDetails.scheduleType,
                                pickupAtUTC: f.pickupDetails.pickupAt,
                                pickupAtCentral: pickupMoment.format('ddd M/D h:mm A')
                            };
                        }
                        
                        detail.fulfillments.push(fDetail);
                    });
                }
                
                orderDetails.push(detail);
            });
        }
        
        res.json({
            totalOrders: allOrdersResult.result.orders?.length || 0,
            orders: orderDetails
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// CALCULATE IMMEDIATE PICKUP - FIX WINDOW CHECK
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
        
        const futureDate = moment().add(7, 'days').toDate();
        const ordersResult = await squareClient.ordersApi.searchOrders({
            locationIds: [process.env.SQUARE_LOCATION_ID],
            query: {
                filter: {
                    stateFilter: { states: ['OPEN', 'DRAFT'] },
                    dateTimeFilter: {
                        createdAt: {
                            startAt: moment().toISOString(),
                            endAt: futureDate.toISOString()
                        }
                    }
                }
            },
            limit: 500
        });
        
        // ✅ Build slot map - CONVERT UTC TO CENTRAL FIRST
        const ordersBySlot = {};
        if (ordersResult.result.orders) {
            ordersResult.result.orders.forEach((order) => {
                if (order.fulfillments?.[0]?.pickupDetails?.pickupAt) {
                    const pickupAt = order.fulfillments[0].pickupDetails.pickupAt;
                    const pickupTime = moment(pickupAt).tz(locationTimezone);
                    
                    const roundedMinute = Math.floor(pickupTime.minute() / 5) * 5;
                    pickupTime.minute(roundedMinute).second(0).millisecond(0);
                    
                    const slotKey = pickupTime.toISOString();
                    ordersBySlot[slotKey] = (ordersBySlot[slotKey] || 0) + 1;
                    
                    console.log(`   Order: ${pickupTime.format('M/D h:mm A')} → Count: ${ordersBySlot[slotKey]}`);
                }
            });
        }
        
        console.log('📊 Total slots with orders:', Object.keys(ordersBySlot).length);
        
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
                    if (candidateMinutes - startMinutes >= minPrepTimeMinutes) {
                        isWithinHours = true;
                        break;
                    }
                }
            }
            
            if (isWithinHours) {
                // ✅ FIX: Check FORWARD window (current + next 2 slots)
                const slot0 = candidateTime.clone().toISOString();
                const slot1 = candidateTime.clone().add(5, 'minutes').toISOString();
                const slot2 = candidateTime.clone().add(10, 'minutes').toISOString();
                
                const count0 = ordersBySlot[slot0] || 0;
                const count1 = ordersBySlot[slot1] || 0;
                const count2 = ordersBySlot[slot2] || 0;
                const totalOrders = count0 + count1 + count2;
                
                console.log(`🔍 ${candidateTime.format('h:mm A')}: ${count0}+${count1}+${count2}=${totalOrders}/${maxOrdersPerWindow}`);
                
                if (totalOrders < maxOrdersPerWindow) {
                    console.log(`✅ FOUND: ${candidateTime.format('ddd M/D h:mm A')}`);
                    
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

// AVAILABLE PICKUP TIMES - 15-MIN INTERVALS
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
        
        const futureDate = moment().add(maxDaysAhead, 'days').toDate();
        const ordersResult = await squareClient.ordersApi.searchOrders({
            locationIds: [process.env.SQUARE_LOCATION_ID],
            query: {
                filter: {
                    stateFilter: { states: ['OPEN', 'DRAFT'] },
                    dateTimeFilter: {
                        createdAt: {
                            startAt: moment().toISOString(),
                            endAt: futureDate.toISOString()
                        }
                    }
                }
            },
            limit: 500
        });
        
        // ✅ Build 5-min slot map
        const ordersBySlot = {};
        if (ordersResult.result.orders) {
            ordersResult.result.orders.forEach(order => {
                if (order.fulfillments?.[0]?.pickupDetails?.pickupAt) {
                    const pickupAt = order.fulfillments[0].pickupDetails.pickupAt;
                    const pickupTime = moment(pickupAt).tz(locationTimezone);
                    
                    const roundedMinute = Math.floor(pickupTime.minute() / 5) * 5;
                    pickupTime.minute(roundedMinute).second(0).millisecond(0);
                    
                    const slotKey = pickupTime.toISOString();
                    ordersBySlot[slotKey] = (ordersBySlot[slotKey] || 0) + 1;
                }
            });
        }
        
        // ✅ Check 15-min window (3 consecutive 5-min slots)
        function canBook15MinSlot(time) {
            const slot0 = time.clone();
            const slot1 = time.clone().add(5, 'minutes');
            const slot2 = time.clone().add(10, 'minutes');
            
            const count0 = ordersBySlot[slot0.toISOString()] || 0;
            const count1 = ordersBySlot[slot1.toISOString()] || 0;
            const count2 = ordersBySlot[slot2.toISOString()] || 0;
            
            return (count0 + count1 + count2) < maxOrdersPerWindow;
        }
        
        let currentSlot = now.clone().add(minPrepTimeMinutes, 'minutes');
        const currentMinute = currentSlot.minute();
        const roundedMinute = Math.ceil(currentMinute / 15) * 15;
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
                        const minutesSinceOpening = currentMinutes - startMinutes;
                        
                        if (minutesSinceOpening >= minPrepTimeMinutes) {
                            if (canBook15MinSlot(currentSlot)) {
                                availableSlots.push({ time: currentSlot.toISOString() });
                            }
                            foundValidSlot = true;
                            break;
                        }
                    }
                }
                
                if (foundValidSlot) {
                    currentSlot.add(slotIntervalMinutes, 'minutes');
                } else {
                    currentSlot.add(slotIntervalMinutes, 'minutes');
                }
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

// DELIVERY AVAILABILITY
app.get('/api/delivery-availability', async (req, res) => {
    try {
        const locationTimezone = 'America/Chicago';
        const now = moment().tz(locationTimezone);
        const deliveryEnabled = process.env.DELIVERY_ENABLED === 'true';
        const deliveryFee = parseFloat(process.env.DELIVERY_FEE) || 5.00;
        const minPrepTimeMinutes = 35;
        const deliveryMinTime = 5;
        const deliveryMaxTime = 15;
        
        if (!deliveryEnabled) {
            return res.json({ available: false, reason: 'Delivery is not currently available' });
        }
        
        const locationResult = await squareClient.locationsApi.retrieveLocation(process.env.SQUARE_LOCATION_ID);
        const businessHours = locationResult.result.location.businessHours?.periods || [];
        
        if (businessHours.length === 0) {
            return res.json({ available: false, reason: 'Store is currently closed' });