const axios = require('axios');
const XLSX = require('xlsx');
const { Command } = require('commander');
const { input, select } = require('@inquirer/prompts');
const { exec } = require('child_process');

const fs = require('fs');
const puppeteer = require('puppeteer');

const SUBSCAN_API_URLS = {
    polkadot: {
        legacy: 'https://polkadot.api.subscan.io/api/v2/scan/account/reward_slash',
        assetHub: 'https://assethub-polkadot.api.subscan.io/api/scan/account/reward_slash'
    },
    kusama: {
        legacy: 'https://kusama.api.subscan.io/api/v2/scan/account/reward_slash',
        assetHub: 'https://assethub-kusama.api.subscan.io/api/scan/account/reward_slash'
    },
};

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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchStakingRewards(address, startDate, endDate, apiUrl) {
    let rewards = [];
    let page = 0;
    const startTimestamp = new Date(startDate).getTime() / 1000;
    const endTimestamp = new Date(endDate).getTime() / 1000;
    let hasMoreData = true;
    let retryCount = 0;

    while (hasMoreData) {
        try {
            console.log(`Fetching rewards from ${apiUrl} page ${page + 1}...`);

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
                        'Content-Type': 'application/json'
                    }
                }
            );

            const rewardList = response.data.data.list || [];

            if (rewardList.length === 0) {
                break;
            }

            const filteredRewards = rewardList.filter(
                reward => reward.block_timestamp >= startTimestamp && reward.block_timestamp <= endTimestamp
            );

            rewards = rewards.concat(filteredRewards);

            const oldestReward = rewardList[rewardList.length - 1];
            if (oldestReward.block_timestamp < startTimestamp) {
                hasMoreData = false;
            } else {
                page++;
            }

            await delay(1000);
            retryCount = 0;
        } catch (error) {
            if (error.response?.data?.code === 20008) {
                retryCount++;
                const waitTime = 2 ** retryCount * 1000;
                console.log(`API rate limit exceeded. Retrying in ${waitTime / 1000} seconds...`);
                await delay(waitTime);
            } else {
                console.error('Error fetching staking rewards:', error.response?.data || error.message);
                throw error;
            }
        }
    }

    return rewards;
}

async function writeToPDF(rewards, tokenPrice, network, address, quarter, year, useBlockNum) {
    const decimals = network === 'polkadot' ? 10 : 12;
    const eraOrBlockLabel = useBlockNum ? 'Block_number' : 'Era';

    const rows = rewards.map((reward) => {
        const amount = reward.amount / Math.pow(10, decimals);
        const row = {
            Date: new Date(reward.block_timestamp * 1000).toLocaleDateString(),
            [eraOrBlockLabel]: useBlockNum ? reward.block_num : reward.era,
            Block_timestamp: reward.block_timestamp,
            Event_index: reward.event_index,
            Event_id: reward.event_index,
            Extrinsic_index: reward.extrinsic_index,
            Amount: amount,
            EUR_Value: amount * tokenPrice
        };
        return row;
    });

    const totalAmount = rows.reduce((sum, row) => sum + row.Amount, 0);
    const totalValue = totalAmount * tokenPrice;
    const tokenTicker = network === 'polkadot' ? 'DOT' : 'KSM';

    rows.push({
        Date: 'Total',
        [eraOrBlockLabel]: '',
        Block_timestamp: '',
        Event_index: '',
        Event_id: '',
        Extrinsic_index: `€ ${tokenPrice} per ${tokenTicker}`,
        Amount: totalAmount + " " + tokenTicker,
        EUR_Value: totalValue
    });

    const headers = Object.keys(rows[0]);
    const html = `
    <html>
    <head>
      <style>
        body { font-family: sans-serif; font-size: 10px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border: 1px solid #333; padding: 4px; word-break: break-word; text-align: left; }
        th { background: #eee; }
      </style>
    </head>
    <body>
      <h2>Rewards - ${year} ${quarter} - ${network}-${address}</h2>
      <table>
        <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
        <tbody>
          ${rows.map(row => `<tr>${headers.map(h => `<td>${row[h] ?? ''}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </body>
    </html>`;

    const fileName = `${year}-${quarter}-${network}-${address}.pdf`;
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.setContent(html);
    await page.pdf({ path: fileName, format: 'A4', landscape: true });
    await browser.close();

    console.log(`PDF file created: ${fileName}`);
}

function writeToExcel(rewards, tokenPrice, network, address, quarter, year, useBlockNum) {
    const decimals = network === 'polkadot' ? 10 : 12;
    const eraOrBlockLabel = useBlockNum ? 'Block_number' : 'Era';

    const worksheetData = rewards.map((reward) => ({
        Date: new Date(reward.block_timestamp * 1000).toLocaleDateString(),
        [eraOrBlockLabel]: useBlockNum ? reward.block_num : reward.era,
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
        [eraOrBlockLabel]: '',
        Extrinsic_index: `€ ${tokenPrice} per token`,
        Amount: totalRewards,
        EUR_Value: totalEurValue
    });

    const worksheet = XLSX.utils.json_to_sheet(worksheetData);
    const columnWidths = Object.keys(worksheetData[0]).map((key) => {
        const maxLength = Math.max(...worksheetData.map(row => String(row[key] || '').length), key.length);
        return { wch: maxLength + 2 };
    });
    worksheet['!cols'] = columnWidths;
    worksheet['!pageSetup'] = { orientation: 'landscape' };

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Rewards');

    XLSX.writeFile(workbook, `${year}-${quarter}-${network}-${address}.xlsx`);
    console.log(`Excel file created: ${year}-${quarter}-${network}-${address}.xlsx`);
}

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

    const yearInput = options.year || await input({
        message: 'Enter the year',
        validate: input => /^\d{4}$/.test(input) || 'Please enter a valid year'
    });
    const year = parseInt(yearInput);

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

    const isPastQ42025 = year > 2025;
    const useBlockNum = isPastQ42025;

    console.log(`Fetching rewards for ${address} on ${network}. Mode: ${useBlockNum ? 'Asset Hub Only' : 'Legacy + Asset Hub'}`);

    try {
        const endpoints = SUBSCAN_API_URLS[network];
        let targetUrls = [endpoints.assetHub];
        
        if (!isPastQ42025) {
            targetUrls.push(endpoints.legacy);
        }

        let allRewards = [];
        for (const url of targetUrls) {
            const rewards = await fetchStakingRewards(address, startDate, endDate, url);
            allRewards = allRewards.concat(rewards);
        }

        if (allRewards.length === 0) {
            console.log('No rewards found for the given period.');
            return;
        }

        allRewards.sort((a, b) => b.block_timestamp - a.block_timestamp);

        const exportFormat = await select({
            message: 'Select export format',
            choices: [
                { name: 'Excel (.xlsx)', value: 'xlsx' },
                { name: 'PDF (.pdf)', value: 'pdf' }
            ]
        });

        if (exportFormat === 'xlsx') {
            writeToExcel(allRewards, price, network, address, quarter, year, useBlockNum);
        } else {
            await writeToPDF(allRewards, price, network, address, quarter, year, useBlockNum);
        }
    } catch (error) {
        console.error('Error processing rewards:', error.message);
    }
})();
