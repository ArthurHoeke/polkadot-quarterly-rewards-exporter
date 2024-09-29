const axios = require('axios');
const { Command } = require('commander');
const xlsx = require('xlsx');
const fs = require('fs');
const program = new Command();

// Subscan API endpoint
const SUBSCAN_API_URL = 'https://polkadot.api.subscan.io/api/v2/scan/account/reward_slash';

// Function to map quarter to months
const quarterToMonths = (year, quarter) => {
    switch (quarter) {
        case 'Q1':
            return [`${year}-01-01`, `${year}-03-31`];
        case 'Q2':
            return [`${year}-04-01`, `${year}-06-30`];
        case 'Q3':
            return [`${year}-07-01`, `${year}-09-30`];
        case 'Q4':
            return [`${year}-10-01`, `${year}-12-31`];
        default:
            throw new Error('Invalid quarter');
    }
};

// Function to fetch staking rewards from Subscan API with pagination
async function fetchStakingRewards(address, startDate, endDate) {
    let rewards = [];
    let page = 0;
    const startTimestamp = new Date(startDate).getTime() / 1000; // Convert to Unix timestamp
    const endTimestamp = new Date(endDate).getTime() / 1000;
    let hasMoreData = true;  // Flag to indicate if more data should be fetched

    while (hasMoreData) {
        const response = await axios.post(
            SUBSCAN_API_URL,
            {
                address: address,
                category: 'Reward',
                page: page,
                row: 100,
                timeout: 0
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    //'X-API-Key': 'your-subscan-api-key-here' // Add your Subscan API key
                }
            }
        );

        const rewardList = response.data.data.list || [];
        
        if (rewardList.length === 0) {
            break; // No more data, exit loop
        }

        // Filter rewards by timestamp
        const filteredRewards = rewardList.filter(
            reward => reward.block_timestamp >= startTimestamp && reward.block_timestamp <= endTimestamp
        );

        rewards = rewards.concat(filteredRewards);

        // If the last reward in the current batch is within the date range, request the next page
        const lastReward = rewardList[rewardList.length - 1];
        if (lastReward.block_timestamp > endTimestamp) {
            hasMoreData = false; // Stop if the last reward is beyond the desired date range
        } else {
            page++; // Fetch the next page
        }
    }

    return rewards;
}

// Function to write staking rewards to an Excel file
function writeToExcel(rewards, tokenPrice) {
    const worksheetData = rewards.map((reward) => ({
        Date: new Date(reward.block_timestamp * 1000).toLocaleDateString(),
        Era: reward.era,
        Block_timestamp: reward.block_timestamp,
        Event_index: reward.event_index,
        Event_id: reward.event_index,
        Extrinsic_index: reward.extrinsic_index,
        Amount: reward.amount / Math.pow(10, 10), 
        EUR_Value: (reward.amount / Math.pow(10, 10)) * tokenPrice
    }));

    // Calculate the total rewards and EUR value
    const totalRewards = worksheetData.reduce((acc, row) => acc + row.Amount, 0);
    const totalEurValue = totalRewards * tokenPrice;

    worksheetData.push({
        Date: 'Total',
        Extrinsic_index: `€ ${tokenPrice} per DOT`,
        Amount: totalRewards,
        EUR_Value: totalEurValue
    });

    const worksheet = xlsx.utils.json_to_sheet(worksheetData);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Rewards');

    xlsx.writeFile(workbook, 'staking_rewards.xlsx');
    console.log('Excel file created: staking_rewards.xlsx');
}

// CLI setup
program
    .requiredOption('-y, --year <year>', 'Year of the rewards')
    .requiredOption('-q, --quarter <quarter>', 'Quarter (Q1, Q2, Q3, Q4)')
    .requiredOption('-a, --address <address>', 'Polkadot wallet address')
    .requiredOption('-p, --price <price>', 'Token price in EUR')
    .parse(process.argv);

(async () => {
    const { year, quarter, address, price } = program.opts();
    const [startDate, endDate] = quarterToMonths(year, quarter);
    const tokenPrice = parseFloat(price);

    console.log(`Fetching staking rewards for ${address} from ${startDate} to ${endDate}...`);

    try {
        const rewards = await fetchStakingRewards(address, startDate, endDate);
        if (rewards.length === 0) {
            console.log('No rewards found for the given period.');
            return;
        }

        writeToExcel(rewards, tokenPrice);
    } catch (error) {
        console.error('Error fetching staking rewards:', error.response?.data || error.message);
    }
})();

