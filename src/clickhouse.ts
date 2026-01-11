// src/clickhouse.ts

const username = 'public_web';
const password = 'a2hkayBzZGlsO2RqIHNsayBsYWpzZCBmbGogc2Rsa2og';
const ch_endpoint = "https://compute.olie.science/ch";

export async function chQuery(query: string): Promise<any> {
    const response = await fetch(`${ch_endpoint}/?query=${encodeURIComponent(query)}&default_format=JSON`, {
        headers: new Headers({
            'Authorization': `Basic ${btoa(username + ':' + password)}`
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ClickHouse error: ${errorText}`);
    }

    return response.json();
}
