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
        const locationTimezone = 'America/Chicago';
        const now = moment().tz(locationTimezone);
        const maxDaysAhead = 14;
        const maxOrdersPerSlot = 2;
        const slotIntervalMinutes = 15;
        const minPrepTimeMinutes = 35;
        
        console.log('⏰ Current time (Local):', now.format('M/D/YYYY, h:mm:ss A'));
        
        // Get location and business hours
        const locationResult = await squareClient.locationsApi.retrieveLocation(
            process.env.SQUARE_LOCATION_ID
        );
        
        const location = locationResult.result.location;
        const businessHours = location.businessHours?.periods || [];
        
        console.log('📍 Location:', location.name);
        console.log('⏱️  Prep time:', minPrepTimeMinutes, 'minutes');
        console.log('🕐 Total business hour periods:', businessHours.length);
        
        if (businessHours.length === 0) {
            return res.json({ pickupTimes: [], metadata: { error: 'No business hours' } });
        }
        
        // Log all periods grouped by day
        console.log('📋 Business Hours by Day:');
        const groupedByDay = {};
        businessHours.forEach(period => {
            if (!groupedByDay[period.dayOfWeek]) {
                groupedByDay[period.dayOfWeek] = [];
            }
            groupedByDay[period.dayOfWeek].push(`${period.startLocalTime}-${period.endLocalTime}`);
        });
        Object.keys(groupedByDay).forEach(day => {
            console.log(`   ${day}: ${groupedByDay[day].join(', ')}`);
        });
        
        // Get existing orders
        const futureDate = moment().add(maxDaysAhead, 'days').toDate();
        
        const ordersResult = await squareClient.ordersApi.searchOrders({
            locationIds: [process.env.SQUARE_LOCATION_ID],
            query: {
                filter: {
                    stateFilter: { states: ['OPEN'] },
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
        
        const ordersBySlot = {};
        if (ordersResult.result.orders) {
            ordersResult.result.orders.forEach(order => {
                if (order.fulfillments?.[0]?.pickupDetails?.pickupAt) {
                    const pickupTime = order.fulfillments[0].pickupDetails.pickupAt;
                    ordersBySlot[pickupTime] = (ordersBySlot[pickupTime] || 0) + 1;
                }
            });
        }
        
        console.log('📦 Existing orders in slots:', Object.keys(ordersBySlot).length);
        
        // Start from now + prep time
        let currentSlot = now.clone().add(minPrepTimeMinutes, 'minutes');
        
        console.log('🎯 Earliest with prep:', currentSlot.format('M/D/YYYY, h:mm A'));
        
        const availableSlots = [];
        const endDate = now.clone().add(maxDaysAhead, 'days');
        let iterations = 0;
        const maxIterations = 2000;
        
        while (currentSlot.isBefore(endDate) && availableSlots.length < 200 && iterations < maxIterations) {
            iterations++;
            
            const dayOfWeek = currentSlot.format('ddd').toUpperCase();
            const hour = currentSlot.hour();
            const minute = currentSlot.minute();
            const currentMinutes = hour * 60 + minute;
            
            // ✅ FIX: Get ALL periods for this day
            const dayPeriods = businessHours.filter(period => period.dayOfWeek === dayOfWeek);
            
            if (dayPeriods.length > 0) {
                let foundValidSlot = false;
                let jumpedToNextPeriod = false;
                
                // Check each period for this day
                for (const period of dayPeriods) {
                    const [startHour, startMin] = period.startLocalTime.split(':').map(Number);
                    const [endHour, endMin] = period.endLocalTime.split(':').map(Number);
                    
                    const startMinutes = startHour * 60 + startMin;
                    const endMinutes = endHour * 60 + endMin;
                    
                    // If before this period's start, jump to start + prep
                    if (currentMinutes < startMinutes) {
                        currentSlot.hour(startHour).minute(startMin).second(0).millisecond(0);
                        currentSlot.add(minPrepTimeMinutes, 'minutes');
                        
                        // Round to next 15-minute interval
                        const remainder = 15 - (currentSlot.minute() % 15);
                        if (remainder !== 15) {
                            currentSlot.add(remainder, 'minutes');
                        }
                        jumpedToNextPeriod = true;
                        break;
                    }
                    
                    // If within this period
                    if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
                        const minutesSinceOpening = currentMinutes - startMinutes;
                        
                        // Check if enough prep time has passed
                        if (minutesSinceOpening >= minPrepTimeMinutes) {
                            // Round to 15-minute interval
                            const remainder = currentSlot.minute() % 15;
                            if (remainder !== 0) {
                                currentSlot.add(15 - remainder, 'minutes');
                                jumpedToNextPeriod = true;
                                break;
                            }
                            
                            const slotKey = currentSlot.toISOString();
                            const ordersInSlot = ordersBySlot[slotKey] || 0;
                            
                            if (ordersInSlot < maxOrdersPerSlot) {
                                availableSlots.push({
                                    time: slotKey,
                                    ordersInSlot: ordersInSlot,
                                    spotsLeft: maxOrdersPerSlot - ordersInSlot
                                });
                            }
                            
                            foundValidSlot = true;
                            break;
                        }
                    }
                }
                
                if (jumpedToNextPeriod) {
                    continue;
                }
                
                if (foundValidSlot) {
                    currentSlot.add(slotIntervalMinutes, 'minutes');
                } else {
                    // Not in any valid period, move forward
                    currentSlot.add(slotIntervalMinutes, 'minutes');
                }
            } else {
                // No periods for this day - skip to next day
                currentSlot.add(1, 'day').startOf('day');
            }
        }
        
        console.log(`✅ Generated ${availableSlots.length} slots (${iterations} iterations)`);
        if (availableSlots.length > 0) {
            const first = moment(availableSlots[0].time).tz(locationTimezone);
            const last = moment(availableSlots[availableSlots.length - 1].time).tz(locationTimezone);
            console.log(`   First: ${first.format('ddd M/D/YYYY, h:mm A')}`);
            console.log(`   Last: ${last.format('ddd M/D/YYYY, h:mm A')}`);
        }
        
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

// CALCULATE IMMEDIATE PICKUP TIME (Just get first available slot!)
app.get('/api/calculate-immediate-pickup', async (req, res) => {
    try {
        console.log('⚡ Getting first available pickup slot for ASAP order');
        
        // Reuse the same logic as available-pickup-times
        const locationTimezone = 'America/Chicago';
        const now = moment().tz(locationTimezone);
        const minPrepTimeMinutes = parseInt(process.env.MIN_PREP_TIME_MINUTES) || 35;
        const immediateSlotInterval = 5; // 5-minute increments for ASAP
        
        // Get location and business hours
        const locationResult = await squareClient.locationsApi.retrieveLocation(
            process.env.SQUARE_LOCATION_ID
        );
        
        const location = locationResult.result.location;
        const businessHours = location.businessHours?.periods || [];
        
        if (businessHours.length === 0) {
            return res.status(400).json({ error: 'Store is currently closed' });
        }
        
        // Start from now + prep time
        let readyTime = now.clone().add(minPrepTimeMinutes, 'minutes');
        
        console.log('⏱  Prep time:', minPrepTimeMinutes, 'minutes');
        console.log('📍 Initial ready time:', readyTime.format('M/D/YYYY, h:mm:ss A'));
        
        // Round UP to nearest 5-minute increment (ASAP uses 5-min, not 15-min)
        const currentMinute = readyTime.minute();
        const roundedMinute = Math.ceil(currentMinute / immediateSlotInterval) * immediateSlotInterval;
        readyTime.minute(roundedMinute).second(0).millisecond(0);
        
        console.log('🎯 Rounded ready time (5-min):', readyTime.format('M/D/YYYY, h:mm A'));
        
        // Check if within business hours
        const dayOfWeek = readyTime.format('ddd').toUpperCase();
        const readyMinutes = readyTime.hour() * 60 + readyTime.minute();
        
        const dayPeriods = businessHours.filter(period => period.dayOfWeek === dayOfWeek);
        let isWithinHours = false;
        
        for (const period of dayPeriods) {
            const [startHour, startMin] = period.startLocalTime.split(':').map(Number);
            const [endHour, endMin] = period.endLocalTime.split(':').map(Number);
            
            const startMinutes = startHour * 60 + startMin;
            const endMinutes = endHour * 60 + endMin;
            
            if (readyMinutes >= startMinutes && readyMinutes < endMinutes) {
                // Make sure there's enough time after opening for prep
                const minutesSinceOpening = readyMinutes - startMinutes;
                if (minutesSinceOpening >= minPrepTimeMinutes) {
                    isWithinHours = true;
                    break;
                }
            }
        }
        
        if (!isWithinHours) {
            console.log('⚠️ Ready time falls outside business hours, finding next opening');
            
            // Find next opening
            let daysChecked = 0;
            let nextOpenTime = null;
            
            while (daysChecked < 7 && !nextOpenTime) {
                const checkDay = now.clone().add(daysChecked, 'days');
                const checkDayOfWeek = checkDay.format('ddd').toUpperCase();
                const periodsForDay = businessHours.filter(p => p.dayOfWeek === checkDayOfWeek);
                
                if (periodsForDay.length > 0) {
                    const earliestPeriod = periodsForDay.sort((a, b) => {
                        return a.startLocalTime.localeCompare(b.startLocalTime);
                    })[0];
                    
                    const [hour, min] = earliestPeriod.startLocalTime.split(':').map(Number);
                    nextOpenTime = checkDay.clone()
                        .hour(hour)
                        .minute(min)
                        .second(0)
                        .millisecond(0)
                        .add(minPrepTimeMinutes, 'minutes');
                    
                    // Round to 5-min increment
                    const nextMinute = nextOpenTime.minute();
                    const nextRounded = Math.ceil(nextMinute / immediateSlotInterval) * immediateSlotInterval;
                    nextOpenTime.minute(nextRounded);
                }
                
                daysChecked++;
            }
            
            if (nextOpenTime) {
                readyTime = nextOpenTime;
                console.log('✅ Next available time:', readyTime.format('ddd M/D/YYYY, h:mm A'));
            } else {
                return res.status(400).json({ error: 'No available pickup times in the next week' });
            }
        }
        
        console.log(`✅ ASAP pickup time: ${readyTime.format('ddd M/D/YYYY, h:mm A')}`);
        
        res.json({
            readyTime: readyTime.toISOString(),
            prepTimeMinutes: minPrepTimeMinutes,
            slotInterval: immediateSlotInterval
        });
        
    } catch (error) {
        console.error('❌ Error calculating immediate pickup:', error);
        res.status(500).json({
            error: 'Failed to calculate pickup time',
            details: error.message
        });
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
            
            const pricePerUnit = item.price / item.quantity;
            const lineItem = {
                name: item.name,
                quantity: String(item.quantity),
                basePriceMoney: {
                    amount: BigInt(Math.round(pricePerUnit * 100)),
                    currency: 'USD'
                }
            };

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