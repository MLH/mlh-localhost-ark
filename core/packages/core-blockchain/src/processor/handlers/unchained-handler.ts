// tslint:disable:max-classes-per-file

import { app } from "@arkecosystem/core-container";
import { models } from "@arkecosystem/crypto";
import { Blockchain } from "../../blockchain";
import { BlockProcessorResult } from "../block-processor";
import { BlockHandler } from "./block-handler";

enum UnchainedBlockStatus {
    NotReadyToAcceptNewHeight,
    ExceededNotReadyToAcceptNewHeightMaxAttempts,
    AlreadyInBlockchain,
    EqualToLastBlock,
    GeneratorMismatch,
    DoubleForging,
    InvalidTimestamp,
}

class BlockNotReadyCounter {
    public static maxAttempts = 5;

    private id = "";
    private attempts = 0;

    public increment(block: models.Block): boolean {
        const { id } = block.data;
        let attemptsLeft = false;

        if (this.id !== id) {
            this.reset();
            this.id = id;
        }

        this.attempts += 1;

        attemptsLeft = this.attempts <= BlockNotReadyCounter.maxAttempts;
        if (!attemptsLeft) {
            this.reset();
        }

        return attemptsLeft;
    }

    public reset() {
        this.attempts = 0;
        this.id = "";
    }
}

export class UnchainedHandler extends BlockHandler {
    public static notReadyCounter = new BlockNotReadyCounter();

    public constructor(
        protected blockchain: Blockchain,
        protected block: models.Block,
        private isValidGenerator: boolean,
    ) {
        super(blockchain, block);
    }

    public async execute(): Promise<BlockProcessorResult> {
        super.execute();

        this.blockchain.processQueue.clear();

        const status = this.checkUnchainedBlock();
        switch (status) {
            case UnchainedBlockStatus.DoubleForging: {
                const database = app.resolvePlugin("database");
                const delegates = await database.getActiveDelegates(this.block.data.height);
                if (delegates.some(delegate => delegate.publicKey === this.block.data.generatorPublicKey)) {
                    this.blockchain.forkBlock(this.block);
                }

                return BlockProcessorResult.Rejected;
            }

            case UnchainedBlockStatus.ExceededNotReadyToAcceptNewHeightMaxAttempts: {
                this.blockchain.forkBlock(this.block, 5000); // TODO: find a better heuristic based on peer information
                return BlockProcessorResult.DiscardedButCanBeBroadcasted;
            }

            case UnchainedBlockStatus.GeneratorMismatch:
            case UnchainedBlockStatus.InvalidTimestamp: {
                return BlockProcessorResult.Rejected;
            }

            default: {
                return BlockProcessorResult.DiscardedButCanBeBroadcasted;
            }
        }
    }

    private checkUnchainedBlock(): UnchainedBlockStatus {
        const lastBlock = this.blockchain.getLastBlock();
        if (this.block.data.height > lastBlock.data.height + 1) {
            this.logger.debug(
                `Blockchain not ready to accept new block at height ${this.block.data.height.toLocaleString()}. Last block: ${lastBlock.data.height.toLocaleString()} :warning:`,
            );

            // Also remove all remaining queued blocks. Since blocks are downloaded in batches,
            // it is very likely that all blocks will be disregarded at this point anyway.
            // NOTE: This isn't really elegant, but still better than spamming the log with
            //       useless `not ready to accept` messages.
            if (this.blockchain.processQueue.length() > 0) {
                this.logger.debug(`Discarded ${this.blockchain.processQueue.length()} downloaded blocks.`);
            }

            // If we consecutively fail to accept the same block, our chain is likely forked. In this
            // case `increment` returns false.
            if (UnchainedHandler.notReadyCounter.increment(this.block)) {
                return UnchainedBlockStatus.NotReadyToAcceptNewHeight;
            }

            this.logger.debug(
                `Blockchain is still not ready to accept block at height ${this.block.data.height.toLocaleString()} after ${
                    BlockNotReadyCounter.maxAttempts
                } tries. Going to rollback. :warning:`,
            );

            return UnchainedBlockStatus.ExceededNotReadyToAcceptNewHeightMaxAttempts;
        } else if (this.block.data.height < lastBlock.data.height) {
            this.logger.debug(
                `Block ${this.block.data.height.toLocaleString()} disregarded because already in blockchain :warning:`,
            );

            return UnchainedBlockStatus.AlreadyInBlockchain;
        } else if (this.block.data.height === lastBlock.data.height && this.block.data.id === lastBlock.data.id) {
            this.logger.debug(`Block ${this.block.data.height.toLocaleString()} just received :chains:`);
            return UnchainedBlockStatus.EqualToLastBlock;
        } else if (this.block.data.timestamp < lastBlock.data.timestamp) {
            this.logger.debug(
                `Block ${this.block.data.height.toLocaleString()} disregarded, because the timestamp is lower than the previous timestamp.`,
            );
            return UnchainedBlockStatus.InvalidTimestamp;
        } else {
            if (this.isValidGenerator) {
                this.logger.warn(`Detect double forging by ${this.block.data.generatorPublicKey} :chains:`);
                return UnchainedBlockStatus.DoubleForging;
            }

            this.logger.info(
                `Forked block disregarded because it is not allowed to be forged. Caused by delegate: ${
                    this.block.data.generatorPublicKey
                } :bangbang:`,
            );

            return UnchainedBlockStatus.GeneratorMismatch;
        }
    }
}
