const axios = require('axios');
const xlsx = require('xlsx');
const { Command } = require('commander');
const { input, select } = require('@inquirer/prompts');

// Subscan API URLs
const SUBSCAN_API_URLS = {
    polkadot: 'https://polkadot.api.subscan.io/api/v2/scan/account/reward_slash',
    kusama: 'https://kusama.api.subscan.io/api/v2/scan/account/reward_slash',
};

// Function to map quarter to months
const quarterToMonths = (year, quarter) => {
    switch (quarter) {
        case 'Q1':
            return [`${year}-01-01T00:00:00Z`, `${year}-03-31T23:59:59Z`];
        case 'Q2':
            return [`${year}-04-01T00:00:00Z`, `${year}-06-30T23:59:59Z`];
        case 'Q3':
            return [`${year}-07-01T00:00:00Z`, `${year}-09-30T23:59:59Z`];
        case 'Q4':
            return [`${year}-10-01T00:00:00Z`, `${year}-12-31T23:59:59Z`];
        default:
            throw new Error('Invalid quarter');
    }
};

// Helper function to introduce a delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Function to fetch staking rewards from Subscan API with pagination and delays
async function fetchStakingRewards(address, startDate, endDate, apiUrl) {
    let rewards = [];
    let page = 0;
    const startTimestamp = new Date(startDate).getTime() / 1000; // Convert to Unix timestamp
    const endTimestamp = new Date(endDate).getTime() / 1000;
    let hasMoreData = true;
    let retryCount = 0;

    while (hasMoreData) {
        try {
            console.log(`Fetching rewards from page ${page + 1}...`);

            const response = await axios.post(
                apiUrl,
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
                console.log('No more rewards found.');
                break;
            }

            const filteredRewards = rewardList.filter(
                reward => reward.block_timestamp >= startTimestamp && reward.block_timestamp <= endTimestamp
            );

            rewards = rewards.concat(filteredRewards);

	    const oldestReward = rewardList[rewardList.length - 1];
            if (oldestReward.block_timestamp < startTimestamp) {
                hasMoreData = false; // Stop if the last reward is beyond the desired date range
            } else {
                page++; // Fetch the next page
            }

            // Delay between requests (1 second)
            await delay(1000);
            retryCount = 0; // Reset retry count on successful request
        } catch (error) {
            if (error.response?.data?.code === 20008) {
                // Handle rate limit exceeded
                retryCount++;
                const waitTime = 2 ** retryCount * 1000; // Exponential backoff
                console.log(`API rate limit exceeded. Retrying in ${waitTime / 1000} seconds...`);
                await delay(waitTime);
            } else {
                console.error('Error fetching staking rewards:', error.response?.data || error.message);
                throw error; // Exit loop on non-rate limit errors
            }
        }
    }

    return rewards;
}

// Function to write staking rewards to an Excel file
function writeToExcel(rewards, tokenPrice, network, address, quarter, year) {
    const decimals = network === 'polkadot' ? 10 : 12;

    const worksheetData = rewards.map((reward) => ({
        Date: new Date(reward.block_timestamp * 1000).toLocaleDateString(),
        Era: reward.era,
        Block_timestamp: reward.block_timestamp,
        Event_index: reward.event_index,
        Event_id: reward.event_index,
        Extrinsic_index: reward.extrinsic_index,
        Amount: reward.amount / Math.pow(10, decimals),
        EUR_Value: (reward.amount / Math.pow(10, decimals)) * tokenPrice
    }));

    const totalRewards = worksheetData.reduce((acc, row) => acc + row.Amount, 0);
    const totalEurValue = totalRewards * tokenPrice;

    worksheetData.push({
        Date: 'Total',
        Extrinsic_index: `€ ${tokenPrice} per token`,
        Amount: totalRewards,
        EUR_Value: totalEurValue
    });

    const worksheet = xlsx.utils.json_to_sheet(worksheetData);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Rewards');

    xlsx.writeFile(workbook, `${year}-${quarter}-${network}-${address}.xlsx`);
    console.log(`Excel file created: ${year}-${quarter}-${network}-${address}.excel`);
}

// Function to fetch token price from CoinGecko API
async function fetchTokenPrice(network) {
    const tokenId = network === 'polkadot' ? 'polkadot' : 'kusama';
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${tokenId}&vs_currencies=eur`;

    try {
        const response = await axios.get(url);
        return response.data[tokenId].eur;
    } catch (error) {
        console.error('Error fetching token price from CoinGecko:', error.message);
        throw error;
    }
}

// CLI setup
const program = new Command();
program
    .option('-n, --network <network>', 'Network (polkadot or kusama)')
    .option('-y, --year <year>', 'Year of the rewards')
    .option('-q, --quarter <quarter>', 'Quarter (Q1, Q2, Q3, Q4)')
    .option('-a, --address <address>', 'Wallet address')
    .option('-p, --price <price>', 'Token price in EUR')
    .parse(process.argv);

(async () => {
    const options = program.opts();

    const network = options.network || await select({
        message: 'Select the network',
        choices: [
            { name: 'Polkadot', value: 'polkadot' },
            { name: 'Kusama', value: 'kusama' }
        ]
    });

    const year = options.year || await input({
        message: 'Enter the year',
        validate: input => /^\d{4}$/.test(input) || 'Please enter a valid year'
    });

    const quarter = options.quarter || await select({
        message: 'Select the quarter',
        choices: [
            { name: 'Q1', value: 'Q1' },
            { name: 'Q2', value: 'Q2' },
            { name: 'Q3', value: 'Q3' },
            { name: 'Q4', value: 'Q4' }
        ]
    });

    const address = options.address || await input({
        message: 'Enter the wallet address',
        validate: input => !!input || 'Please enter a valid wallet address'
    });

    let price = options.price || await input({
        message: 'Enter the token price in EUR (leave empty to fetch from CoinGecko)',
        validate: input => !input || !isNaN(parseFloat(input)) || 'Please enter a valid number'
    });

    const [startDate, endDate] = quarterToMonths(year, quarter);

    if (!price) {
        console.log(`Fetching token price for ${network} from CoinGecko...`);
        try {
            price = await fetchTokenPrice(network);
            console.log(`Token price for ${network}: €${price}`);
        } catch (error) {
            console.error('Unable to fetch token price.');
            process.exit(1);
        }
    } else {
        price = parseFloat(price);
    }

    console.log(`Fetching staking rewards for ${address} on ${network} from ${startDate} to ${endDate}...`);

    try {
        const apiUrl = SUBSCAN_API_URLS[network];
        const rewards = await fetchStakingRewards(address, startDate, endDate, apiUrl);
        if (rewards.length === 0) {
            console.log('No rewards found for the given period.');
            return;
        }

        writeToExcel(rewards, price, network, address, quarter, year);
    } catch (error) {
        console.error('Error fetching staking rewards:', error.response?.data || error.message);
    }
})();

