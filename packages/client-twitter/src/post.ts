import { Tweet } from "agent-twitter-client";
import {
    composeContext,
    generateText,
    getEmbeddingZeroVector,
    IAgentRuntime,
    ModelClass,
    stringToUuid,
    parseBooleanFromText,
} from "@ai16z/eliza";
import { elizaLogger } from "@ai16z/eliza";
import { ClientBase } from "./base.ts";
import { Scraper } from "agent-twitter-client";
import { clusterApiUrl, Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { IDL, SwapIntent } from "./idl.ts";
import { AnchorProvider, Program, web3, Wallet } from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import * as spl from "@solana/spl-token";
import axios from "axios";
import { encode } from "@coral-xyz/anchor/dist/cjs/utils/bytes/bs58";
import { Buffer } from "buffer";
import bs58 from 'bs58'
import pkg from '@coral-xyz/anchor';
const { BN } = pkg;



const twitterPostTemplate = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

# Task: Generate a post in the voice and style and perspective of {{agentName}} @{{twitterUserName}}.
Write a 1-3 sentence post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
Your response should not contain any questions. Brief, concise statements only. The total character count MUST be less than 280. No emojis. Use \\n\\n (double spaces) between statements.`;

const twitterPollTemplate = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

# Task: Generate a text for the twitter poll in the voice and style and perspective of {{agentName}} @{{twitterUserName}}.`


function getPollTemplate(tokens) {
    const topic = `Write a short desciption from the perspective of {{agentName}} for twitter poll. The poll is about choosing what token to buy from this list of tokens: ${tokens}. Dont add extra poll options except item in this list: ${tokens}. You may add comment for each of the tokens from the list ${tokens} but do not create poll. this is complementary comment to the poll, it should not contain poll options. dont provide poll options to choose from. Do not add commentary or acknowledge this request, just write the post. Brief, concise statements only. The total character count MUST be less than 280.`;
    return twitterPollTemplate + topic
}

function generateIntentId(length: number): string {
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    const array = new Uint8Array(length);

    // Use crypto to generate secure random bytes
    crypto.getRandomValues(array);

    // Ensure array[i] is defined and map random values to alphanumeric characters
    for (let i = 0; i < length; i++) {
      const randomValue = array[i];
      if (randomValue !== undefined) {
        result += chars.charAt(randomValue % chars.length);
      }
    }

    return result;
  }
const INDEXER_INTERVAL = 10 * 1000; // 10s
const JITO_ENDPOINT = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";
const MAX_TWEET_LENGTH = 280;
const ASSETS = ["PYTH", "JITO", "Chill Guy", "Popcat", "WIF", "Bonk"]
const ASSETS_CONTRACT_MAP = {
    "PYTH": {"address": "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", "decimals": 6 },
    "JITO": {"address":"jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", "decimals": 9 },
    "Chill Guy": {"address":"Df6yfrKC8kZE3KNkrHERKzAetSxbrWeniQfyJY4Jpump", "decimals": 6 },
    "Popcat": {"address":"7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", "decimals": 9 },
    "WIF": {"address":"EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", "decimals": 6 },
    "Bonk": {"address":"DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "decimals": 5 },
}
export const PROGRAM_ID = "AhfoGVmS19tvkEG2hBuZJ1D6qYEjyFmXZ1qPoFD6H4Mj";

/**
 * Truncate text to fit within the Twitter character limit, ensuring it ends at a complete sentence.
 */
function truncateToCompleteSentence(text: string): string {
    if (text.length <= MAX_TWEET_LENGTH) {
        return text;
    }

    // Attempt to truncate at the last period within the limit
    const truncatedAtPeriod = text.slice(
        0,
        text.lastIndexOf(".", MAX_TWEET_LENGTH) + 1
    );
    if (truncatedAtPeriod.trim().length > 0) {
        return truncatedAtPeriod.trim();
    }

    // If no period is found, truncate to the nearest whitespace
    const truncatedAtSpace = text.slice(
        0,
        text.lastIndexOf(" ", MAX_TWEET_LENGTH)
    );
    if (truncatedAtSpace.trim().length > 0) {
        return truncatedAtSpace.trim() + "...";
    }

    // Fallback: Hard truncate and add ellipsis
    return text.slice(0, MAX_TWEET_LENGTH - 3).trim() + "...";
}
export async function sendBundle(rawTx: Uint8Array | number[] | Buffer) {
    const result = await axios.post(JITO_ENDPOINT, {
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [[encode(rawTx)]],
    });
    const data = await result.data;
    console.log(
      { data: result.data.result, encodeRawTx: encode(rawTx) },
      "bundleId",
    );
    return { bundleId: data.result };
  }

async function pollingBundleInfo(bundleId: string, count = 9) {
    for await (const i of [...Array(count).keys()]) {
      const { signature, status } = await getBundleInfo(bundleId);
      if (status === "finalized" || status === "confirmed") {
        return { signature, status }; // pretend it is finalized, to avoid fixing other status
      }
      if (i > 9) {
        return { signature, status: status };
      }
      await new Promise((resolve) => setTimeout(resolve, 6000)); // Try again in 5s // 6s
    }
  }

async function getBundleInfo(bundleId: string) {
    try {
    const d = await axios.post(JITO_ENDPOINT, {
        jsonrpc: "2.0",
        id: 1,
        method: "getBundleStatuses",
        params: [[bundleId]],
    });

    const data = await d.data;

    console.log(data, "bundleResult", JSON.stringify(data));
    if (data.result.value.length === 0) return { signature: "", status: "" };
        return {
            signature: data.result.value?.[0]?.transactions?.[0] || "",
            status: data.result.value?.[0]?.confirmation_status,
        };
    } catch (err) {
        // if there is error, throw finalzied with empty signature
        return { signature: "", status: "finalized" };
    }
}

export class TwitterPostClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    clientV2: Scraper;

    async start(postImmediately: boolean = false) {
        if (!this.client.profile) {
            await this.client.init();
        }

        this.clientV2 = new Scraper();
        const res = await this.clientV2.login(
            this.runtime.getSetting("TWITTER_USERNAME"),
            this.runtime.getSetting("TWITTER_PASSWORD"),
            this.runtime.getSetting("TWITTER_EMAIL"),
            undefined,
            this.runtime.getSetting("TWITTER_APP_KEY"),
            this.runtime.getSetting("TWITTER_APP_KEY_SECRET"),
            this.runtime.getSetting("TWITTER_ACCESS_TOKEN"),
            this.runtime.getSetting("TWITTER_ACCESS_TOKEN_SECRET"),
        );

        const generateNewTweetLoop = async () => {
            const lastPost = await this.runtime.cacheManager.get<{
                timestamp: number;
            }>(
                "twitter/" +
                    this.runtime.getSetting("TWITTER_USERNAME") +
                    "/lastPost"
            );

            const lastPostTimestamp = lastPost?.timestamp ?? 0;
            const minMinutes =
                parseInt(this.runtime.getSetting("POST_INTERVAL_MIN")) || 90;
            const maxMinutes =
                parseInt(this.runtime.getSetting("POST_INTERVAL_MAX")) || 180;
            const randomMinutes =
                Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) +
                minMinutes;
            const delay = randomMinutes * 60 * 1000;

            if (Date.now() > lastPostTimestamp + delay) {
                await this.generateNewTweet();
            }

            setTimeout(() => {
                generateNewTweetLoop(); // Set up next iteration
            }, delay);

            elizaLogger.log(`Next tweet scheduled in ${randomMinutes} minutes`);
        };
        if (
            this.runtime.getSetting("POST_IMMEDIATELY") != null &&
            this.runtime.getSetting("POST_IMMEDIATELY") != ""
        ) {
            postImmediately = parseBooleanFromText(
                this.runtime.getSetting("POST_IMMEDIATELY")
            );
        }
        if (postImmediately) {
            this.generateNewTweet();
        }

        const generateNewPollLoop = async () => {
            const lastPoll = await this.runtime.cacheManager.get<{
                timestamp: number;
            }>(
                "twitter/" +
                    this.runtime.getSetting("TWITTER_USERNAME") +
                    "/lastPoll"
            );

            const lastPostTimestamp = lastPoll?.timestamp ?? 0;
            const minMinutes =
                parseInt(this.runtime.getSetting("POLL_INTERVAL_MIN")) || 90;
            const maxMinutes =
                parseInt(this.runtime.getSetting("POLL_INTERVAL_MAX")) || 180;
            const randomMinutes =
                Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) +
                minMinutes;
            const delay = randomMinutes * 60 * 1000;

            if (Date.now() > lastPostTimestamp + delay) {
                await this.generateNewPoll();
            }

            setTimeout(() => {
                generateNewPollLoop(); // Set up next iteration
            }, delay);

            elizaLogger.log(`Next poll scheduled in ${randomMinutes} minutes`);
        };
        if (
            this.runtime.getSetting("POLL_IMMEDIATELY") != null &&
            this.runtime.getSetting("POLL_IMMEDIATELY") != ""
        ) {
            postImmediately = parseBooleanFromText(
                this.runtime.getSetting("POST_IMMEDIATELY")
            );
        }
        if (postImmediately) {
            this.generateNewPoll();
        }

        const generateNewSwapLoop = async () => {
            const lastPoll = await this.runtime.cacheManager.get<{
                timestamp: number;
                id: string;
            }>(
                "twitter/" +
                    this.runtime.getSetting("TWITTER_USERNAME") +
                    "/lastPoll"
            );

            const lastPollSwap = await this.runtime.cacheManager.get<{
                timestamp: number;
                id: string;
            }>(
                "twitter/" +
                    this.runtime.getSetting("TWITTER_USERNAME") +
                    "/lastPollSwap"
            );

            const lastPollId = lastPoll?.id ?? null;
            const lastPollSwapId = lastPollSwap?.id ?? null;

            const lastPostTimestamp = lastPoll?.timestamp ?? 0;
            const pollVoteTime =
                (parseInt(this.runtime.getSetting("POLL_VOTING_TIME")) || 90)* 60 * 1000;
            elizaLogger.log(`Should i swap? lastPollId ${lastPollId} lastPollSwapId ${lastPollSwapId} lastPostTimestamp ${lastPostTimestamp} pollVoteTime ${pollVoteTime} now ${Date.now()}`);
            if (lastPollId != null && lastPollSwapId != lastPollId && Date.now() > lastPostTimestamp + pollVoteTime) {
                await this.generateNewSwap(lastPollId);
            }
            // change it to start the loop only after poll is done
            setTimeout(() => {
                generateNewSwapLoop(); // Set up next iteration
            }, Number(
                this.runtime.getSetting("TWITTER_SWAP_INTERVAL") || 1
            ) * 60 * 1000);

            elizaLogger.log(`Next check for a swap scheduled in ${this.runtime.getSetting("TWITTER_SWAP_INTERVAL")} minutes`);
        };

        generateNewTweetLoop();



        generateNewPollLoop();



        generateNewSwapLoop();

    }

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
    }

    private async generateNewTweet() {
        elizaLogger.log("Generating new tweet");

        try {
            const roomId = stringToUuid(
                "twitter_generate_room-" + this.client.profile.username
            );
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.client.profile.username,
                this.runtime.character.name,
                "twitter"
            );

            const topics = this.runtime.character.topics.join(", ");
            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: roomId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: topics,
                        action: "",
                    },
                },
                {
                    twitterUserName: this.client.profile.username,
                }
            );

            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates?.twitterPostTemplate ||
                    twitterPostTemplate,
            });

            elizaLogger.debug("generate post prompt:\n" + context);

            const newTweetContent = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            // Replace \n with proper line breaks and trim excess spaces
            const formattedTweet = newTweetContent
                .replaceAll(/\\n/g, "\n")
                .trim();

            // Use the helper function to truncate to complete sentence
            const content = truncateToCompleteSentence(formattedTweet);

            if (this.runtime.getSetting("TWITTER_DRY_RUN") === "true") {
                elizaLogger.info(
                    `Dry run: would have posted tweet: ${content}`
                );
                return;
            }

            try {
                elizaLogger.log(`Posting new tweet:\n ${content}`);

                const result = await this.client.requestQueue.add(
                    async () =>
                        await this.client.twitterClient.sendTweet(content)
                );
                const body = await result.json();
                if (!body?.data?.create_tweet?.tweet_results?.result) {
                    console.error("Error sending tweet; Bad response:", body);
                    return;
                }
                const tweetResult = body.data.create_tweet.tweet_results.result;

                const tweet = {
                    id: tweetResult.rest_id,
                    name: this.client.profile.screenName,
                    username: this.client.profile.username,
                    text: tweetResult.legacy.full_text,
                    conversationId: tweetResult.legacy.conversation_id_str,
                    createdAt: tweetResult.legacy.created_at,
                    timestamp: new Date(
                        tweetResult.legacy.created_at
                    ).getTime(),
                    userId: this.client.profile.id,
                    inReplyToStatusId:
                        tweetResult.legacy.in_reply_to_status_id_str,
                    permanentUrl: `https://twitter.com/${this.runtime.getSetting("TWITTER_USERNAME")}/status/${tweetResult.rest_id}`,
                    hashtags: [],
                    mentions: [],
                    photos: [],
                    thread: [],
                    urls: [],
                    videos: [],
                } as Tweet;

                await this.runtime.cacheManager.set(
                    `twitter/${this.client.profile.username}/lastPost`,
                    {
                        id: tweet.id,
                        timestamp: Date.now(),
                    }
                );

                await this.client.cacheTweet(tweet);

                elizaLogger.log(`Tweet posted:\n ${tweet.permanentUrl}`);

                await this.runtime.ensureRoomExists(roomId);
                await this.runtime.ensureParticipantInRoom(
                    this.runtime.agentId,
                    roomId
                );

                await this.runtime.messageManager.createMemory({
                    id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: newTweetContent.trim(),
                        url: tweet.permanentUrl,
                        source: "twitter",
                    },
                    roomId,
                    embedding: getEmbeddingZeroVector(),
                    createdAt: tweet.timestamp,
                });
            } catch (error) {
                elizaLogger.error("Error sending tweet:", error);
            }
        } catch (error) {
            elizaLogger.error("Error generating new tweet:", error);
        }
    }

    private async generateNewPoll() {
        elizaLogger.log("Generating new Poll");

        try {
            const roomId = stringToUuid(
                "twitter_generate_room-" + this.client.profile.username
            );
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.client.profile.username,
                this.runtime.character.name,
                "twitter"
            );
            const selectedAssets = ASSETS.sort(() => 0.5 - Math.random()).slice(0, 3);
            const assets = selectedAssets.join(", ");
            elizaLogger.log(`Assets to choose from `+ assets);
            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: roomId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: "generate a text for a twitter poll for what to buy from this list: " + assets,
                        action: "",
                    },
                },
                {
                    twitterUserName: this.client.profile.username,
                }
            );

            const context = composeContext({
                state,
                template:
                getPollTemplate(assets),
            });

            elizaLogger.debug("generate poll prompt:\n" + context);

            const newPollContent = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            // Replace \n with proper line breaks and trim excess spaces
            const formattedTweet = newPollContent
                .replaceAll(/\\n/g, "\n")
                .trim();

            // Use the helper function to truncate to complete sentence
            const content = truncateToCompleteSentence(formattedTweet);

            if (this.runtime.getSetting("TWITTER_DRY_RUN") === "true") {
                elizaLogger.info(
                    `Dry run: would have posted tweet: ${content}`
                );
                return;
            }

            try {
                elizaLogger.log(`Posting new poll:\n ${content}`);

                // // Log in to Twitter using the configured environment variables
                // const scraper = new Scraper();
                // const res = await scraper.login(
                //     this.runtime.getSetting("TWITTER_USERNAME"),
                //     this.runtime.getSetting("TWITTER_PASSWORD"),
                //     this.runtime.getSetting("TWITTER_EMAIL"),
                //     undefined,
                //     this.runtime.getSetting("TWITTER_APP_KEY"),
                //     this.runtime.getSetting("TWITTER_APP_KEY_SECRET"),
                //     this.runtime.getSetting("TWITTER_ACCESS_TOKEN"),
                //     this.runtime.getSetting("TWITTER_ACCESS_TOKEN_SECRET"),
                // );
                // Check if logged in
                const isLoggedIn = await this.clientV2.isLoggedIn();
                elizaLogger.log(`V2 client Logged in? ${isLoggedIn}`);
                if (!isLoggedIn) {
                    elizaLogger.error("Error logging in to Twitter");
                    return;
                }

                const result = await this.client.requestQueue.add(
                    async () =>
                        await this.clientV2.sendTweetV2(content, undefined, {poll: {
                            options: selectedAssets.map((asset) => ({label: asset})),
                            duration_minutes: parseInt(this.runtime.getSetting("POLL_VOTING_TIME")) || 90, // Duration of the poll in minutes
                          }},)
                );
                if (result == null) {
                    console.error("Error sending tweet; Bad response");
                    return;
                }
                const tweet = {
                    id: result.id,
                    name: this.client.profile.screenName,
                    username: this.client.profile.username,
                    text: result.text,
                    conversationId: result.conversationId,
                    createdAt: result.timestamp,
                    timestamp: new Date(
                        result.timestamp
                    ).getTime(),
                    userId: this.client.profile.id,
                    inReplyToStatusId:
                        result.inReplyToStatusId,
                    permanentUrl: `https://twitter.com/${this.runtime.getSetting("TWITTER_USERNAME")}/status/${result.id}`,
                    hashtags: [],
                    mentions: [],
                    photos: [],
                    thread: [],
                    urls: [],
                    videos: [],
                } as Tweet;

                await this.runtime.cacheManager.set(
                    `twitter/${this.client.profile.username}/lastPoll`,
                    {
                        id: tweet.id,
                        timestamp: Date.now(),
                    }
                );

                await this.client.cacheTweet(tweet);

                elizaLogger.log(`Tweet posted:\n ${tweet.permanentUrl}`);

                await this.runtime.ensureRoomExists(roomId);
                await this.runtime.ensureParticipantInRoom(
                    this.runtime.agentId,
                    roomId
                );

                await this.runtime.messageManager.createMemory({
                    id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: newPollContent.trim(),
                        url: tweet.permanentUrl,
                        source: "twitter",
                    },
                    roomId,
                    embedding: getEmbeddingZeroVector(),
                    createdAt: tweet.timestamp,
                });
            } catch (error) {
                elizaLogger.error("Error sending poll:", error);
            }
        } catch (error) {
            elizaLogger.error("Error generating new poll:", error);
        }
    }



    private async generateNewSwap(latestPollId: string) {

        try {
            elizaLogger.log("Generating new Swap");
                const result = await this.client.requestQueue.add(
                    async () =>
                        await this.clientV2.getTweetV2(latestPollId)
                );

               if (result == null) {
                    elizaLogger.log("Error getting poll; Bad response");
                    return;
                }

               elizaLogger.log("fetched tweet", result);
               const poll = await result.poll;
               elizaLogger.log("fetched poll", poll);
               if (poll.voting_status != "closed") {
                    elizaLogger.log("Poll is not closed yet");
                    return;
               }
               // find the winner
               const winnerToken = poll.options.sort((a, b) => b.votes - a.votes)[0];
               const winnerTokenContract = ASSETS_CONTRACT_MAP[winnerToken.label].address;
               const winnerTokenDecimals = ASSETS_CONTRACT_MAP[winnerToken.label].decimals;


            //    const winnerTokenContract = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
            //    const winnerTokenDecimals = 5;

               elizaLogger.log("winnerTokenContract, winnerTokenDecimals", winnerTokenContract, winnerTokenDecimals);

               const intentId = generateIntentId(6);

               const timeout = 300 * 1000;
                const timeoutTimestamp = Math.round(new Date().getTime() + timeout);

                // TODO set better numbers
                const SOL_SWAP_AMOUNT = 0.05;
                const AMOUNT_OUT = 1;

               // makeing a swap
                const signer = Keypair.fromSecretKey(
                    bs58.decode(this.runtime.getSetting("SOLANA_PRIVATE_KEY"))
                );

                const connection = new Connection(clusterApiUrl("mainnet-beta"));


                const provider = new AnchorProvider(
                    connection,
                    signer as any, // (window as any).solana,
                    {
                      skipPreflight: false, // True for dev env, false for prod
                      commitment: "processed",
                    },
                  );
                  const programIdPDA = new web3.PublicKey(PROGRAM_ID);
                  const program = new Program(IDL as SwapIntent, programIdPDA, provider);
                  const [auctioneerState, _bump] = web3.PublicKey.findProgramAddressSync(
                    [Buffer.from("auctioneer")],
                    programIdPDA,
                  );
                  const [intentStatePDA, _] = web3.PublicKey.findProgramAddressSync(
                    [Buffer.from("intent"), Buffer.from(intentId)],
                    programIdPDA,
                  );
                  const tokenInPubkey = spl.NATIVE_MINT;
                  elizaLogger.log("3", tokenInPubkey,programIdPDA);
                  elizaLogger.log("auctioneerState", auctioneerState,intentStatePDA);

                    const userTokenInAddr = await spl.getAssociatedTokenAddress(
                        tokenInPubkey,
                        signer.publicKey,
                      );

                      const tokenInEscrowAddr = await spl.getAssociatedTokenAddress(
                        tokenInPubkey,
                        auctioneerState,
                        true,
                      );
                      const newIntent = {
                        intentId,
                        userIn: signer.publicKey,
                        userOut: signer.publicKey.toString(),
                        tokenIn: tokenInPubkey,
                        tokenOut: winnerTokenContract,
                        amountIn: new BN(
                          Math.floor(
                            Number(SOL_SWAP_AMOUNT) * 10 ** 9,
                          ),
                        ),
                        amountOut: String(
                            Number(AMOUNT_OUT) * 10 ** winnerTokenDecimals,
                        ),
                        timeoutTimestampInSec: new BN(timeoutTimestamp / 1000),
                        singleDomain: true,
                      };

                      elizaLogger.log("4", userTokenInAddr, tokenInEscrowAddr, "newIntent", newIntent);

                      const wrapSOLIxs: web3.TransactionInstruction[] = [];

                        const user = signer.publicKey;
                        const associatedToken = spl.getAssociatedTokenAddressSync(
                          spl.NATIVE_MINT,
                          user,
                        );

                        const quantity = Math.floor(
                            Number(SOL_SWAP_AMOUNT) * 10 ** 9,
                        );

                        //	save coin balance
                        const tokenInfo = await connection.getParsedTokenAccountsByOwner(user, {
                          programId: spl.TOKEN_PROGRAM_ID,
                        });

                        const isWSOL = !!tokenInfo.value.find(
                          (token) =>
                            token.account.data.parsed.info.mint === spl.NATIVE_MINT.toString(),
                        );

                        if (isWSOL) {
                          wrapSOLIxs.push(
                            web3.SystemProgram.transfer({
                              fromPubkey: user,
                              toPubkey: associatedToken,
                              lamports: BigInt(quantity),
                            }),
                            spl.createSyncNativeInstruction(associatedToken, spl.TOKEN_PROGRAM_ID),
                          );
                        } else {
                          wrapSOLIxs.push(
                            // add  instruction for creating wSOL account
                            spl.createAssociatedTokenAccountInstruction(
                              user,
                              associatedToken,
                              user,
                              spl.NATIVE_MINT,
                              spl.TOKEN_PROGRAM_ID,
                              spl.ASSOCIATED_TOKEN_PROGRAM_ID,
                            ),
                            //add instruction for sol to wsol swap
                            web3.SystemProgram.transfer({
                              fromPubkey: user,
                              toPubkey: associatedToken,
                              lamports: BigInt(quantity),
                            }),
                            spl.createSyncNativeInstruction(associatedToken, spl.TOKEN_PROGRAM_ID),
                          );
                        }
                        elizaLogger.log("weird stuff with wsol");
                      const txIx = await program.methods
                        .escrowAndStoreIntent(newIntent)
                        .preInstructions([
                          web3.ComputeBudgetProgram.setComputeUnitLimit({
                            units: 1_000_000,
                          }),
                          web3.ComputeBudgetProgram.setComputeUnitPrice({
                            microLamports: 150_000,
                          }),
                        ])
                        .accounts({
                          user: signer.publicKey,
                          userTokenAccount: userTokenInAddr,
                          auctioneerState,
                          tokenMint: tokenInPubkey,
                          escrowTokenAccount: tokenInEscrowAddr,
                          intent: intentStatePDA,

                          tokenProgram: spl.TOKEN_PROGRAM_ID,
                          associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
                          systemProgram: web3.SystemProgram.programId,
                        })
                        .instruction();

                        elizaLogger.log("weird stuff with txIx");
                      const messageV0 = new web3.TransactionMessage({
                        payerKey: signer.publicKey,
                        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
                        instructions: [getTips(signer.publicKey.toString(), 500000), ...wrapSOLIxs, txIx],
                      }).compileToV0Message();

                      elizaLogger.log("weird stuff with messageV0");
                      const transaction = new web3.VersionedTransaction(messageV0);
                      const wallet = await new Wallet(signer)
                      const signedTx = await wallet.signTransaction(transaction);
                               elizaLogger.log("after sign");
                      const { bundleId } = await sendBundle(signedTx.serialize());
                      elizaLogger.log("after bundleId");
                      const confirmation = await pollingBundleInfo(bundleId);

                      elizaLogger.log("confirmation", confirmation.signature);

                      const txConfirmationRes = await fetch(
                        "http://34.78.217.187:8080/solana_tx_hash",
                        {
                          method: "POST",
                          headers: {
                            "Content-Type": "text/plain",
                          },
                          body: confirmation.signature as string,
                        },
                      );
                      elizaLogger.log("solana_tx_hash", await txConfirmationRes.text());

            // //ignore for basic tweet
            const roomId = stringToUuid(
                "twitter_generate_room-" + this.client.profile.username
            );
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.client.profile.username,
                this.runtime.character.name,
                "twitter"
            );

            const winnerName = winnerToken.label;

            try {

                const getTradeUrl = ({
                    fromAddress,
                    toAddress,
                    fromNetwork,
                    toNetwork,
                  }: {
                    fromAddress: string;
                    toAddress: string;
                    fromNetwork: string;
                    toNetwork: string;
                  }) =>
                    `/trade?assetIn=${fromAddress}&assetOut=${toAddress}&networkIn=${fromNetwork}&networkOut=${toNetwork}`;

                const intentLink = `https://mantis.app${getTradeUrl({
                    fromAddress: "11111111111111111111111111111111",
                    toAddress: winnerTokenContract,
                    fromNetwork: "solana",
                    toNetwork: "solana",
                  })}`;
                  const newTweetContent =
                    `I just traded SOL for ${winnerName} on @mantis. You can do the same with my link ${intentLink}\nSign up at mantis.app using my referral link: https://mantis.app?ref=486ca6597cc7\nTrack my wallet https://solscan.io/account/CA5T7JGLJuATapU9wN4HNw8NCW3Jx8wcDQQ8CSGFDtMy\nBreak Free`;


                // Use the helper function to truncate to complete sentence
            const content = newTweetContent;
            elizaLogger.log(`Posting new swap:\n ${newTweetContent}`);


                elizaLogger.log(`Posting new swap:\n ${content}`);

                const result = await this.client.requestQueue.add(
                    async () =>
                        await this.client.twitterClient.sendTweet(content)
                );
                const body = await result.json();
                if (!body?.data?.create_tweet?.tweet_results?.result) {
                    console.error("Error sending tweet; Bad response:", body);
                    return;
                }
                const tweetResult = body.data.create_tweet.tweet_results.result;
                const tweet = {
                    id: tweetResult.rest_id,
                    name: this.client.profile.screenName,
                    username: this.client.profile.username,
                    text: tweetResult.legacy.full_text,
                    conversationId: tweetResult.legacy.conversation_id_str,
                    createdAt: tweetResult.legacy.created_at,
                    timestamp: new Date(
                        tweetResult.legacy.created_at
                    ).getTime(),
                    userId: this.client.profile.id,
                    inReplyToStatusId:
                        tweetResult.legacy.in_reply_to_status_id_str,
                    permanentUrl: `https://twitter.com/${this.runtime.getSetting("TWITTER_USERNAME")}/status/${tweetResult.rest_id}`,
                    hashtags: [],
                    mentions: [],
                    photos: [],
                    thread: [],
                    urls: [],
                    videos: [],
                } as Tweet;

                await this.runtime.cacheManager.set(
                    `twitter/${this.client.profile.username}/lastPost`,
                    {
                        id: tweet.id,
                        timestamp: Date.now(),
                    }
                );

                await this.runtime.cacheManager.set(
                    `twitter/${this.client.profile.username}/lastPollSwap`,
                    {
                        id: latestPollId,
                        timestamp: Date.now(),
                    }
                );

                await this.client.cacheTweet(tweet);

                elizaLogger.log(`Tweet posted:\n ${tweet.permanentUrl}`);

                await this.runtime.ensureRoomExists(roomId);
                await this.runtime.ensureParticipantInRoom(
                    this.runtime.agentId,
                    roomId
                );

                await this.runtime.messageManager.createMemory({
                    id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: newTweetContent.trim(),
                        url: tweet.permanentUrl,
                        source: "twitter",
                    },
                    roomId,
                    embedding: getEmbeddingZeroVector(),
                    createdAt: tweet.timestamp,
                });
            } catch (error) {
                elizaLogger.error("Error sending tweet:", error);
            }
        } catch (error) {
            elizaLogger.error("Error generating new tweet:", error);
        }
    }
}

export function getTips(accountId: string, lamports = 4000000) {
    //0.000035
    //0.015 -> 15000000  // please add this one
    return SystemProgram.transfer({
      toPubkey: new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"),
      fromPubkey: new PublicKey(accountId),
      lamports,
    });
  }