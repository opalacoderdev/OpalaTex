import asyncio
from pydantic import BaseModel
from agenticblocks.core.block import Block
from agenticblocks.runtime.retry import with_retry

class FetchInput(BaseModel):
    url: str

class FetchOutput(BaseModel):
    raw_data: str

class FetchDataBlock(Block[FetchInput, FetchOutput]):
    name: str = "fetch"
    description: str = "Fetches initial data"
    
    @with_retry(max_attempts=2, delay=0.1)
    async def run(self, input: FetchInput) -> FetchOutput:
        await asyncio.sleep(0.1) # Mock io
        return FetchOutput(raw_data=f"<html>Mock content from {input.url}</html>")

class ParseInput(BaseModel):
    raw_data: str

class ParseOutput(BaseModel):
    parsed_text: str

class ParseBlock(Block[ParseInput, ParseOutput]):
    async def run(self, input: ParseInput) -> ParseOutput:
        await asyncio.sleep(0.1)
        return ParseOutput(parsed_text="Mock content mapped")

class EnrichInput(BaseModel):
    raw_data: str

class EnrichOutput(BaseModel):
    metadata: str

class EnrichBlock(Block[EnrichInput, EnrichOutput]):
    async def run(self, input: EnrichInput) -> EnrichOutput:
        await asyncio.sleep(0.2)
        return EnrichOutput(metadata="{source: mock, verified: true}")

class SummarizeInput(BaseModel):
    parsed_text: str
    metadata: str

class SummarizeOutput(BaseModel):
    message: str
    tokens_used: int

class LLMCallBlock(Block[SummarizeInput, SummarizeOutput]):
    model: str = "claude-mock-fast"

    async def run(self, input: SummarizeInput) -> SummarizeOutput:
        await asyncio.sleep(0.5)
        return SummarizeOutput(
            message=f"Summary of '{input.parsed_text}' with {input.metadata}",
            tokens_used=42
        )
