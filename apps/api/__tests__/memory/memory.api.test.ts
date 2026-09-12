import { memoryController } from '../../../../apps/api/src/controllers/memory.controller';
import { memoryService } from '../../../../apps/api/src/services/memory.service';

jest.mock('../../../../apps/api/src/services/memory.service', () => ({
  memoryService: {
    getUserMemories: jest.fn().mockResolvedValue([{ id: 'mem-1', fact: 'Project Apollo' }]),
    deleteUserMemory: jest.fn().mockResolvedValue(undefined)
  }
}));

describe('Memory API (FR-MEM-4)', () => {
  it('should allow users to view their own long-term memory entries', async () => {
    const mockReq: any = {
      params: { workspace_id: 'ws-123' },
      user: { id: 'user-1' }
    };
    const mockRes: any = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis()
    };

    await memoryController.getMemories(mockReq, mockRes);

    expect(memoryService.getUserMemories).toHaveBeenCalledWith('ws-123', 'user-1');
    expect(mockRes.json).toHaveBeenCalledWith([{ id: 'mem-1', fact: 'Project Apollo' }]);
  });

  it('should allow users to delete specific memory entries', async () => {
    const mockReq: any = {
      params: { workspace_id: 'ws-123', memory_id: 'mem-1' },
      user: { id: 'user-1' }
    };
    const mockRes: any = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn()
    };

    await memoryController.deleteMemory(mockReq, mockRes);

    expect(memoryService.deleteUserMemory).toHaveBeenCalledWith('ws-123', 'user-1', 'mem-1');
    expect(mockRes.status).toHaveBeenCalledWith(204);
    expect(mockRes.send).toHaveBeenCalled();
  });
});
