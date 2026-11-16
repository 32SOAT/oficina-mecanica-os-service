import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class LoginCpfDto {
  @ApiProperty({ example: '529.982.247-25', description: 'CPF do cliente' })
  @IsString()
  @IsNotEmpty()
  cpf: string;
}

export class LoginCpfResponseDto {
  @ApiProperty({ description: 'Token JWT do cliente' })
  token: string;
}
