const version = '1.0.0';

addEventListener('fetch', (event) => {
    event.respondWith(handleRequest(event.request));
});

const CLAUDE_API_KEY = ''; // default claude api key
const CLAUDE_BASE_URL = 'https://api.anthropic.com';
const MAX_TOKENS = 4096; // max tokens to sample

const role_map = {
    system: 'Human',
    user: 'Human',
    assistant: 'Assistant',
};

const stop_reason_map = {
    stop_sequence: 'stop',
    max_tokens: 'length',
};

function convertMessagesToPrompt(messages) {
    let system_prompt = '';
    let result_messages = [];
    for (const message of messages) {
        if (message['role'] === 'system') {
            system_prompt = message['content'];
        } else {
            result_messages.push(message);
        }
    }
    return [system_prompt, result_messages];
}

function getAPIKey(headers) {
    const authorization = headers.authorization;
    if (authorization) {
        return authorization.split(' ')[1] || CLAUDE_API_KEY;
    }
    return CLAUDE_API_KEY;
}

function claudeToChatGPTResponse(claudeResponse) {
    if (claudeResponse['error']) {
        return {
            error: claudeResponse['error'],
        };
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const prompt_tokens = claudeResponse['usage']['input_tokens'];
    const completion_tokens = claudeResponse['usage']['output_tokens'];
    let content = '';
    if (claudeResponse['content']) {
        content = claudeResponse['content'][0]['text'];
    }
    const result = {
        id: claudeResponse['id'],
        object: 'chat.completion',
        created: timestamp,
        model: claudeResponse['model'],
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content: content,
                },
                logprobs: null,
                finish_reason: claudeResponse['stop_reason'],
            },
        ],
        usage: {
            prompt_tokens: prompt_tokens,
            completion_tokens: completion_tokens,
            total_tokens: prompt_tokens + completion_tokens,
        },
    };
    return result;
}

function claudeToChatGPTResponseStream(claudeResponse, id, model) {
    const timestamp = Math.floor(Date.now() / 1000);
    let result = {
        id: id,
        object: 'chat.completion.chunk',
        created: timestamp,
        model,
        choices: [
            {
                index: 0,
                delta: {},
                logprobs: null,
                finish_reason: claudeResponse['stop_reason'] ? claudeResponse['stop_reason'] : null,
            },
        ],
    };
    if (claudeResponse['delta'] && claudeResponse['delta']['text']) {
        result.choices[0].delta['content'] = claudeResponse['delta']['text'];
    }
    return result;
}

async function streamJsonResponseBodies(response, writable) {
    const reader = response.body.getReader();
    const writer = writable.getWriter();

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let buffer = '';
    let id = '';
    let model = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            writer.write(encoder.encode('data: [DONE]'));
            break;
        }
        const currentText = decoder.decode(value, { stream: true }); // stream: true is important here,fix the bug of incomplete line
        console.log("currentText", currentText);

        buffer += currentText;
        const substr = buffer.split('\n\n');
        console.log("substr", substr);

        const lastMsg = substr.length - 1;
        0 !== substr[lastMsg].length ? buffer = substr[lastMsg] : buffer = '';
        // if meet new line, then write the buffer to the writer
        for (let i = 0; i < lastMsg; i++) {
            try {
                const parts = substr[i].split('\n');
                if (parts.length !== 2) {
                    console.log("invalid event", parts);
                    continue;
                }

                if (parts[0] === 'event: message_start') {
                    const decodedLine = JSON.parse(parts[1].slice(5));
                    console.log("decodedLine", decodedLine);
                    id = decodedLine['message']['id'];
                    model = decodedLine['message']['model'];
                } else if (parts[0] === 'event: content_block_delta') {
                    const decodedLine = JSON.parse(parts[1].slice(5));
                    console.log("decodedLine", decodedLine);

                    const transformedLine = claudeToChatGPTResponseStream(decodedLine, id, model);
                    writer.write(
                        encoder.encode(`data: ${JSON.stringify(transformedLine)}\n\n`)
                    );
                } else {
                    console.log("ingore event", parts);
                }
            } catch (e) {
                console.log("exception when parse response", e);
            }
        }
    }
    await writer.close();
}

async function handleRequest(request) {
    if (request.method === 'GET') {
        return new Response('Not Found', { status: 404 });
    } else if (request.method === 'OPTIONS') {
        return handleOPTIONS();
    } else if (request.method === 'POST') {
        const headers = Object.fromEntries(request.headers);
        const apiKey = getAPIKey(headers);
        if (!apiKey) {
            return new Response('Not Allowed', {
                status: 403,
            });
        }

        const requestBody = await request.json();
        let { model, messages, temperature, stop, stream } = requestBody;

        if (!stream) {
            stream = false;
        }

        // OpenAI API 转换为 Claude API
        const [system, claude_messages] = convertMessagesToPrompt(messages);
        let claudeRequestBody = {
            messages: claude_messages,
            model: model,
            max_tokens: MAX_TOKENS,
            stream,
        };
        if (system) {
            claudeRequestBody['system'] = system;
        }
        if (temperature) {
            claudeRequestBody['temperature'] = temperature;
        }

        console.log("requestBody", claudeRequestBody);

        const claudeResponse = await fetch(`${CLAUDE_BASE_URL}/v1/messages`, {
            method: 'POST',
            headers: {
                accept: 'application/json',
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(claudeRequestBody),
        });

        if (!stream) {
            const claudeResponseBody = await claudeResponse.json();
            console.log("claudeResponseBody", claudeResponseBody);

            const openAIResponseBody = claudeToChatGPTResponse(claudeResponseBody);
            return new Response(JSON.stringify(openAIResponseBody), {
                status: claudeResponse.status,
                headers: { 'Content-Type': 'application/json' },
            });
        } else {
            const { readable, writable } = new TransformStream();
            streamJsonResponseBodies(claudeResponse, writable);
            return new Response(readable, {
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': '*',
                    'Access-Control-Allow-Headers': '*',
                    'Access-Control-Allow-Credentials': 'true',
                },
            });
        }
    } else {
        return new Response('Method not allowed', { status: 405 });
    }
}

function handleOPTIONS() {
    return new Response(null, {
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Allow-Credentials': 'true',
        },
    });
}
